/**
 * Cron：每天扫一遍 active 订阅，抓到价就发信（GET /api/cron/check-prices）
 *
 * 由 Vercel Cron 每天触发一次（见 vercel.json）。也可以手动带 Bearer 触发。
 *
 * ── 凭什么敢「发完就结束」──
 * 产品的语义是：用户给一条航线设了目标价，我们盯着；一旦到价发一封，这条监控结束。
 * 同一天不会重复发（幂等），同一个订阅最多两封：
 *   · hit      —— 跌破目标价，等到了
 *   · deadline —— 到了他自己设的决策截止日还没到价，发一封收尾信
 * 两封都发完 → status 变 expired（「已结束」，页面靠 last_notified_at 区分「已提醒 / 已过期」）。
 *
 * ⚠️ 到期信里**绝不能写「之后不会降了」** —— 我们没有未来数据，那是编造。
 *
 * ── 为什么必须鉴权 ──
 * 这是公开域名上的接口，谁都能打。不设防 = 任何人反复触发就能烧掉主人的 Apify 额度
 * （每触发一次至少一次日历抓取）。Vercel Cron 会自动带上 `Authorization: Bearer $CRON_SECRET`，
 * 所以「有密钥」这一件事同时满足了自动化与防刷。
 *
 * ── 为什么 60 秒是硬约束 ──
 * Serverless 函数上限 60 秒（vercel.json maxDuration），而单次日历抓取要 20~60 秒。
 * 所以一次运行**实际只能安全处理 1 条**订阅。这里用时间预算控制：剩余时间不够跑完一条
 * 就不再开始新的，宁可少做也不让函数被平台掐断（掐断 = 数据库写到一半、状态不明）。
 * 订阅多了要分摊（按 id 轮转 / 拆天），不是靠「加大超时」。
 */
import { getSupabase } from '../_supabase.js';
import { getPriceCalendar } from '../_apify.js';
import { todayShanghai, markExpiredRows } from '../_expire.js';
import { toClient } from '../_translate.js';
import { buildPriceAlert, buildDeadlineNotice, sendMail, isMailConfigured } from '../_mail.js';

/** 从这一刻起不再开始新的订阅（给写库与响应留余量，离平台 60s 上限还有 15s） */
const BUDGET_MS = 45_000;
/** 单条最坏耗时：日历抓取 20~60s（内部 50s 超时）+ 发信 20s。保守按 35s 估 */
const PER_SUB_MS = 35_000;

/** 两个 YYYY-MM-DD 相差几天（b - a）。纯日期字符串按 UTC 解析，不经过本地时区 */
function diffDays(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** 站点地址：Vercel 会给 host 头；本机给个默认值，便于在信里点开 */
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : '';
}

/** 这个订阅是否已经有**成功发出**的记录 —— 幂等的唯一依据 */
async function findSentLog(subscriptionId) {
  const { data, error } = await getSupabase()
    .from('notify_log')
    .select('id, kind, price, notified_at')
    .eq('subscription_id', subscriptionId)
    .eq('send_status', 'sent')
    .limit(1);

  if (error) throw new Error(`查通知记录失败：${error.message}`);
  return data?.[0] ?? null;
}

/** 写一条通知流水。航线走快照列（订阅将来被删也不影响这条记录） */
async function logNotice(row, price, kind, sendStatus, note) {
  const { error } = await getSupabase().from('notify_log').insert({
    owner_id: row.owner_id,
    subscription_id: row.id,
    origin: row.origin,
    destination: row.destination,
    price,
    kind,
    send_status: sendStatus,
  });

  if (error) throw new Error(`写通知记录失败（${sendStatus}）：${error.message}`);
  if (note) console.log(`[cron][${sendStatus}] ${row.origin}→${row.destination} ${note}`);
}

/**
 * 读「邮件通知总开关」（设置页 setting.vue 的那个）。
 *
 * 语义以设置页文案为准：**关掉 = 不再发信，但订阅仍在监控**。
 * 所以它只决定第 ⑤ 步「发不发信」，绝不影响抓价与回写 current_price ——
 * 价格在更前面就已经落库了，页面照常看到最新价。
 *
 * 读不到要分两种情况，不能一锅端：
 *   · 表里没这行 → 用户从没设置过，按默认开启（与 api/settings.js 的 DEFAULTS 一致）
 *   · 查询报错   → 按「关闭」处理：宁可这轮不发信，也不发一封用户可能早就关掉的邮件。
 *                  价格照常回写，监控本身不断；原因写进 degraded 供日志追溯。
 */
async function readNotifyEnabled(ownerId) {
  const { data, error } = await getSupabase()
    .from('user_settings')
    .select('notify_enabled')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) return { enabled: false, degraded: `读取邮件开关失败：${error.message}` };
  if (!data) return { enabled: true, degraded: null };
  return { enabled: data.notify_enabled !== false, degraded: null };
}

/** 一条订阅的使命结束：标 expired + 记下发信时间。这两件事必须一起做，否则状态会说谎 */
async function finish(row, notifiedAt) {
  const { error } = await getSupabase()
    .from('subscriptions')
    .update({
      status: 'expired',
      last_notified_at: notifiedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  if (error) throw new Error(`结束订阅失败：${error.message}`);
  row.status = 'expired';
}

/** 只更新「当前最低价」—— 没到价也要把数据刷新，用户打开页面看到的是今天的价 */
async function saveCurrentPrice(row, price) {
  const checkedAt = new Date().toISOString();

  const { error } = await getSupabase()
    .from('subscriptions')
    // last_checked_at 单独记，不复用 updated_at —— 后者用户改阈值/邮箱时也会写，
    // 拿它当「这个价格是几点抓的」会变成谎报（见 db/schema.sql 该列的注释）
    .update({ current_price: price, last_checked_at: checkedAt, updated_at: checkedAt })
    .eq('id', row.id);

  if (error) throw new Error(`回写当前价失败：${error.message}`);
  row.current_price = price;
  row.last_checked_at = checkedAt;
}

/**
 * 处理一条订阅。抛错由调用方收集，不影响其它订阅
 * @param {{enabled: boolean, degraded: string|null}} notify 该订阅所属 owner 的邮件总开关
 */
async function handleOne(row, today, summary, notify) {
  const sub = toClient(row);

  // ① 幂等 + 自愈：上次已经发成功、但状态没来得及改成 expired（比如函数刚好被超时掐断）。
  //    这里补完状态就退出，绝不重复发信 —— 宁可第二天少发一封，不能给用户发两封一样的。
  const sent = await findSentLog(row.id);
  if (sent) {
    // ⚠️ dry 模式**一个字都不能写**：试跑改库是这套设计里最不能接受的事（已经踩过一次：
    //    dry 演练顺手把一条 active 的订阅标成了 expired）。所以写操作全部挂在 !dry 上。
    if (row.status === 'active' && !summary.dry) await finish(row, sent.notified_at);
    summary.alreadySent += 1;
    if (summary.dry) {
      summary.wouldSend.push({
        to: sub.email,
        kind: 'skip',
        price: sent.price ?? null,
        subject: `（跳过）该订阅已有成功通知记录`,
      });
    }
    return;
  }

  // ② 舱位护栏：日历源只查经济舱（_apify 里固定 economy）。
  //    拿经济舱的分位数去给商务舱的订阅下结论就是错的。宁可这轮不做，也不发一封错价邮件。
  //    ★ 2026-10-23 已在入口把非经济舱订阅挡掉了（api/subscriptions/index.js 的 POST），
  //      这段现在是**防历史数据**的兜底，不是主路径 —— 别因为「走不到」就删掉。
  if (sub.cabin && sub.cabin !== 'economy') {
    summary.skipped.push(`${sub.from}→${sub.to}：舱位 ${sub.cabin}，日历源只支持经济舱，本轮跳过`);
    return;
  }

  // ③ 窗口天数：Apify 的日历是「从今天起连续 N 天」，要包住目标出发日
  const days = diffDays(today, sub.departDate) + 1;
  if (days <= 0) return; // 出发日已过，上面 markExpiredRows 已经处理

  const calendar = await getPriceCalendar({ origin: sub.from, destination: sub.to, days });
  const cell = calendar.find((d) => d.day === sub.departDate);
  const price = cell?.price ?? null;

  if (price !== null && !summary.dry) await saveCurrentPrice(row, price);
  summary.checked += 1;

  // ④ 该不该发：到价 → 命中信；没到价但今天已经是决策截止日 → 到期信。两者都不满足就什么都不做
  const hit = price !== null && price <= sub.threshold;
  const dueDeadline = sub.deadline <= today;
  if (!hit && !dueDeadline) return;

  const kind = hit ? 'hit' : 'deadline';

  // ⑤ 邮件总开关：关掉 = 不发信，但**监控照旧**（价格在上面已经回写完了，页面看得到最新价）。
  //    此时**不写 notify_log、也不置 expired** —— 订阅的使命没有结束，只是这封信先不发。
  //    用户哪天重新打开开关，第二天若仍命中就正常发信，不会漏掉。
  //    必须放在 dry 判断之前：dry 演练也要能看出「本来会发、但因为开关关着没发」。
  if (!notify.enabled) {
    summary.muted.push({
      route: `${sub.from}→${sub.to}`,
      to: sub.email,
      kind,
      price,
      note: notify.degraded ?? '邮件通知已关闭',
    });
    return;
  }

  // 演练模式：走到「本来要发信」这一步就停，不写库、不发信，只报出来。
  // 为什么要留这个口子：真跑一次会花钱、会真发邮件、还会把订阅改成 expired，
  // 而这三件事都是不可逆的。上线前先 dry 一次，能看清「今天到底会发什么、发给谁」。
  if (summary.dry) {
    summary.wouldSend.push({
      to: sub.email,
      kind,
      price,
      subject: (hit
        ? buildPriceAlert(sub, price, summary.siteUrl)
        : buildDeadlineNotice(sub, price, summary.siteUrl)
      ).subject,
    });
    return;
  }
  const mail = hit
    ? buildPriceAlert(sub, price, summary.siteUrl)
    : buildDeadlineNotice(sub, price, summary.siteUrl);

  // notify_log.price 是 not null：这轮没抓到价时退到「上次记的当前价 → 订阅时价格」，
  // 并且到期信的正文会如实写「暂时没拿到报价」，不假装有价
  const logPrice = price ?? sub.currentPrice ?? sub.basePrice;

  try {
    const { messageId } = await sendMail({ to: sub.email, subject: mail.subject, text: mail.text });
    console.log(`[cron][mail] ${kind} → ${sub.email} messageId=${messageId}`);
  } catch (e) {
    // 发信失败：留一条 failed 记录便于排查，订阅保持 active，明天重试
    await logNotice(row, logPrice, kind, 'failed');
    summary.failed.push(`${sub.from}→${sub.to}：${e.message}`);
    return;
  }

  await logNotice(row, logPrice, kind, 'sent');
  await finish(row, new Date().toISOString());
  if (hit) summary.hit += 1;
  else summary.deadline += 1;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ code: 4050, message: '只支持 GET（Cron 触发）', data: null });
    return;
  }

  // 缺密钥 = 部署没配好。此时**拒绝执行**而不是放行：放行等于把花钱的接口公开给全网
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({
      code: 5000,
      message: '缺少环境变量 CRON_SECRET，拒绝执行（否则任何人都能触发这个会花钱的接口）',
      data: null,
    });
    return;
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    res.status(401).json({ code: 4010, message: '未授权', data: null });
    return;
  }

  if (!isMailConfigured()) {
    res.status(500).json({
      code: 5000,
      message: '缺少环境变量 MAIL_USER / MAIL_PASS，发不出信，本轮不执行',
      data: null,
    });
    return;
  }

  const started = Date.now();
  const today = todayShanghai();
  const dry = ['1', 'true'].includes(String(req.query?.dry ?? ''));
  const summary = {
    today,
    dry,
    checked: 0, // 真的抓到价的条数
    hit: 0, // 发了命中信
    deadline: 0, // 发了到期信
    alreadySent: 0, // 已有成功记录（幂等跳过 / 补状态）
    wouldSend: [], // 仅 dry 模式：本来会发哪些信
    muted: [], // 该发信了，但「邮件通知」总开关是关的 → 只回写价格、不发信
    failed: [],
    skipped: [],
    expired: 0,
    siteUrl: siteUrl(req),
  };

  try {
    const { data: rows, error } = await getSupabase()
      .from('subscriptions')
      .select('*')
      .eq('status', 'active')
      .order('depart_date', { ascending: true }); // 先到期的先做，时间不够时保证最紧急的被处理

    if (error) throw new Error(`读取订阅失败：${error.message}`);

    // 给「航班已经飞走但还标着 active」的兜底标掉（Cron 上线后这一步仍然要留：
    // 它是唯一不依赖用户打开页面的清理入口）。dry 模式只数不清，避免试跑就改了库
    summary.expired = dry
      ? rows.filter((row) => row.depart_date < today).length
      : await markExpiredRows(rows);

    // dry 模式没真写库，所以要自己把「出发日已过」的排掉，别去给飞走的航班抓价
    const pending = rows.filter((row) => row.status === 'active' && row.depart_date >= today);

    // 邮件开关按 owner 缓存：同一个人有多条订阅时只查一次库。
    // 缓存建在 handler 内而不是模块级 —— 模块级会被 serverless 复用实例带到下一次请求，
    // 那样用户刚关掉开关，下一轮还可能读到「开」。
    const notifyCache = new Map();

    for (let i = 0; i < pending.length; i++) {
      const row = pending[i];
      // 时间不够就不再开始新的：宁可不做，也不要做到一半被平台掐断
      if (Date.now() - started + PER_SUB_MS > BUDGET_MS) {
        summary.skipped.push(`时间预算用尽，剩余 ${pending.length - i} 条本轮未处理`);
        break;
      }
      try {
        if (!notifyCache.has(row.owner_id)) {
          notifyCache.set(row.owner_id, await readNotifyEnabled(row.owner_id));
        }
        await handleOne(row, today, summary, notifyCache.get(row.owner_id));
      } catch (e) {
        // 单条失败不连累整批：记下来，明天 Cron 还会再来看它
        summary.failed.push(`${row.origin}→${row.destination}：${e.message}`);
      }
    }
  } catch (e) {
    res.status(500).json({ code: 5000, message: e.message, data: null });
    return;
  }

  summary.elapsedMs = Date.now() - started;
  console.log('[cron] 本轮结果', JSON.stringify(summary));
  res.status(200).json({ code: 0, message: 'ok', data: summary });
}
