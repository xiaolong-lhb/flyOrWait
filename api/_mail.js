/**
 * 邮件零件（内部共享工具，不是接口）
 *
 * 只干一件事：把「该发什么」变成「真的发出去了」。业务判断（该不该发、发给谁）
 * 不在这里做 —— 那属于 Cron 的职责，这里不重复一遍。
 *
 * ── 通道：QQ 邮箱 SMTP ──
 * 为什么不用 Resend / SendGrid / Mailgun：那些都要**再注册一个账号**，
 * 而项目有条红线「凡要再注册一个账号的方案一律不采纳」。
 * QQ 邮箱开 SMTP 只是在自己已有邮箱里点一下开关，拿一串授权码即可。
 *
 * ⚠️ `MAIL_PASS` 填的是 **16 位授权码**，不是 QQ 登录密码。
 *    填登录密码会得到 `EAUTH` 报错（QQ 明确拒绝明文密码登录第三方客户端）。
 *
 * ⚠️ 密钥只从环境变量读，绝不写进代码、绝不加 `VITE_` 前缀（加了就会打进前端包）。
 *
 * ── 缺配置时怎么办 ──
 * **直接抛错，不静默跳过**。静默跳过 = 用户以为订阅在盯、其实永远收不到信，
 * 是最坏的一种失败：看起来一切正常。调用方（Cron）拿到错误后会把这条记成 failed，
 * 下次还能重试，问题也留在日志里。
 */

import nodemailer from 'nodemailer';

/** SMTP 主机与端口基本固定；留环境变量口子只是为了让本地能指向别处调试 */
const HOST = () => process.env.MAIL_HOST || 'smtp.qq.com';
const PORT = () => Number(process.env.MAIL_PORT || 465);

/** 发件人：默认就是登录的那个邮箱（QQ 要求 From 与登录账号一致，否则会被拒） */
function sender() {
  const user = process.env.MAIL_USER;
  return process.env.MAIL_FROM || user;
}

/** 邮件功能是否配好了 —— health 与 Cron 都用它，判断逻辑只留一处 */
export function isMailConfigured() {
  return Boolean(process.env.MAIL_USER && process.env.MAIL_PASS);
}

/** 惰性创建、复用。缺变量时在这里就抛，不要等到发信那一刻才炸 */
function transport() {
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;

  if (!user || !pass) {
    throw new Error('缺少环境变量 MAIL_USER / MAIL_PASS（QQ 邮箱授权码）');
  }

  return nodemailer.createTransport({
    host: HOST(),
    port: PORT(),
    secure: PORT() === 465, // 465 是 SSL，587 是 STARTTLS；QQ 用 465
    auth: { user, pass },
    // 三层超时的第二层：SMTP 自己先超时，别把整个 Serverless 函数拖到被平台掐断。
    // 平台上限 60s，这里给 15s 建连 + 20s 等待，剩下的时间留给业务逻辑与写库。
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/**
 * 发一封纯文本邮件（同时带一个极简 HTML 版本，手机上看更清楚）
 *
 * @param {{ to: string, subject: string, text: string }} p
 * @returns {Promise<{ messageId: string, accepted: string[] }>}
 */
export async function sendMail({ to, subject, text }) {
  const info = await transport().sendMail({
    from: sender(),
    to,
    subject,
    text,
    html: textToHtml(text),
  });

  // accepted 为空 = SMTP 收下了但服务器拒收这个收件人（比如地址不存在）。
  // 这种情况不能算成功，否则库里会写下一条假的「已通知」。
  const accepted = (info.accepted || []).map(String);
  if (!accepted.length) {
    throw new Error(`SMTP 未接受收件人：${to}`);
  }

  return { messageId: info.messageId, accepted };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 以下只负责「文案」，不发信
 *
 * 文案的硬规则（和页面同一条标准）：
 *   ① 价格必须叫「参考价」—— 我们只是抓了某个来源的报价，不承诺能买到；
 *   ② **不预测未来**。到期信只能说「仍高于你的目标价」，绝不能写「不会降价了」。
 *      我们没有未来数据，写那句话就是编造。
 *   ③ 说清楚这条监控接下来会怎样（结束 / 不再提醒），让用户不用猜。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 把订阅里的日期 2026-11-18 显示成 11 月 18 日（周X） */
function prettyDate(iso) {
  if (!iso) return '—';
  // 纯日期字符串按 UTC 解析，再取 UTC 字段 —— 不经过本地时区，避免差一天
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const week = '日一二三四五六'[d.getUTCDay()];
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日（周${week}）`;
}

/** 订阅 → 信里共用的「航线信息」几行 */
function routeLines(sub) {
  return [
    `航线：${sub.from} → ${sub.to}`,
    `出发：${prettyDate(sub.departDate)}`,
    sub.cabin ? `舱位：${sub.cabin}` : '',
    sub.passengers > 1 ? `人数：${sub.passengers} 人` : '',
  ].filter(Boolean);
}

/**
 * 命中信：价格到了你的目标价
 *
 * @param {object} sub 订阅（前端字段形状，from/to/departDate/threshold…）
 * @param {number} price 触发价格（该出发日的最低参考价）
 * @param {string} siteUrl 站点地址，用来放「去网站看看」的链接（Cron 从请求头拿）
 */
export function buildPriceAlert(sub, price, siteUrl) {
  const diff = sub.threshold - price;
  const subject = `[flyOrWait] ${sub.from} → ${sub.to} ${sub.departDate} 出现了 ¥${price}，已低于你的目标价`;

  const text = [
    `你盯的这条航线到价了。`,
    ``,
    ...routeLines(sub),
    ``,
    `当前最低参考价：¥${price}`,
    `你设置的目标价：¥${sub.threshold}`,
    diff > 0 ? `比你的目标价还低 ¥${diff}` : '',
    ``,
    `这条监控到此结束，不会再重复提醒。`,
    sub.basePrice ? `（订阅时的价格是 ¥${sub.basePrice}）` : '',
    ``,
    siteUrl ? `查看详情：${siteUrl}` : '',
    ``,
    `—— flyOrWait · 该买机票吗`,
    `这封邮件由系统自动发送。价格是抓取到的参考价，不代表一定能买到，下单前请以购票平台为准。`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text };
}

/**
 * 到期信：到了你设的决策截止日，价格还没到目标
 *
 * @param {object} sub
 * @param {number} price 截止日的价格（抓不到时为 null）
 * @param {string} siteUrl
 */
export function buildDeadlineNotice(sub, price, siteUrl) {
  const subject = `[flyOrWait] ${sub.from} → ${sub.to} ${sub.departDate} 已到你的决策截止日`;

  const priceLine =
    price === null || price === undefined
      ? `最近一次抓到的价格：暂时没拿到（数据源这次没有报价）`
      : `当前最低参考价：¥${price}（你的目标价是 ¥${sub.threshold}）`;

  const text = [
    `你给这条航线设的决策截止日是 ${prettyDate(sub.deadline)}，今天是最后一天。`,
    ``,
    ...routeLines(sub),
    ``,
    priceLine,
    ``,
    price === null || price === undefined
      ? ''
      : `价格仍未达到你的目标价。之后会不会更便宜，我们无法预判 —— 能说的就到这里。`,
    ``,
    `按你的设置，这条监控到此结束，不会再提醒。`,
    `如果还想继续盯，可以重新订阅并把目标价、截止日调整一下。`,
    ``,
    siteUrl ? `去网站看看：${siteUrl}` : '',
    ``,
    `—— flyOrWait · 该买机票吗`,
    `这封邮件由系统自动发送。价格是抓取到的参考价，不代表一定能买到，下单前请以购票平台为准。`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text };
}

/** 极简 HTML：纯文本按行转义后拼段落。不引外部样式/图片，邮件客户端里才稳定 */
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = text
    .split('\n')
    .map((line) => (line.trim() ? `<p style="margin:0 0 8px">${esc(line)}</p>` : '<br>'))
    .join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;max-width:520px">${body}</div>`;
}
