-- ══════════════════════════════════════════════════════════════════════
--  FlyOrWait · 数据库结构（Supabase / PostgreSQL）
-- ══════════════════════════════════════════════════════════════════════
--
--  怎么用：Supabase 控制台 → 左侧 SQL Editor → New query → 整段粘贴 → Run
--
--  ★ 可以重复执行：全部带 if not exists，改坏了大不了重跑一遍。
--
--  为什么需要数据库：后端是 serverless 函数，无状态 —— 本地文件只读、
--  内存不保证存活。订阅这种「必须记住」的数据只能放外部仓库。
--
--  四张表：
--    subscriptions  订阅记录（每条 = 一个盯价任务）
--    notify_log     通知流水（每次真的发了降价邮件，追加一条；**不随订阅删除**，见该表说明）
--    user_settings  用户配置（默认通知邮箱 / 邮件开关）
--    query_log      查询日志（用于统计「本月查询次数」）
--
--  身份：项目暂无登录体系，所有记录挂在固定 owner_id = 'owner' 名下。
--        将来接入登录后，这个字段的「值」换成真实 user_id，字段名不变。
-- ══════════════════════════════════════════════════════════════════════

-- gen_random_uuid() 由 pgcrypto 提供（Supabase 默认已装，写上是防呆）
create extension if not exists pgcrypto;


-- ── 表一：订阅记录 ────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id               uuid        primary key default gen_random_uuid(),
  owner_id         text        not null,

  -- 航线。列名不用 from / to —— from 是 SQL 保留字，用了以后每次都得加双引号
  origin           text        not null,          -- 出发机场三字码，如 SZX
  destination      text        not null,          -- 到达机场三字码，如 TYO
  depart_date      date        not null,
  return_date      date,                          -- 往返才有返程日；单程为 null

  -- 订阅时选中的那趟航班。结构会随数据源调整，不值得拆成列，整块存 jsonb
  flight           jsonb,

  base_price       integer     not null,          -- 订阅那一刻的价格
  current_price    integer,                       -- 当前最低价，由 Cron 每天回写
  threshold        integer     not null,          -- 低于它才发信
  deadline         date        not null,          -- 决策截止日，过了就不再提醒

  email            text        not null,
  -- active  = 正在盯价
  -- paused  = 用户手动暂停
  -- expired = 出发日已过，这条监控作废（读列表时由 api/_expire.js 写回，Cron 兜底）
  status           text        not null default 'active'
                   check (status in ('active', 'paused', 'expired')),

  cabin            text,                          -- 舱位，可空
  passengers       smallint    not null default 1,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 上次成功比价的时间（Cron 写完 current_price 就顺手写它），没比过价为 null。
  -- ★ 刻意不复用 updated_at：那一列被用户「改阈值 / 改邮箱」时也会写，
  --   拿它当「这个价格是几点抓的」，会在用户编辑一次之后变成谎报 ——
  --   价格明明还是上次 Cron 抓的，时间却跳到了刚才。
  last_checked_at  timestamptz,
  last_notified_at timestamptz                    -- 上次成功发信的时间，没发过为 null
);


-- 去重：同一 owner 的「同航线 + 同出发日 + 同邮箱」只能有一条。
-- ★ 放在数据库约束里，而不是只靠应用层查一遍 —— 并发请求同时提交也不会插重。
--   撞上这条约束时，接口返回 409 + code 4090（对应约定里的「资源冲突」）。
create unique index if not exists subscriptions_dedupe_key
  on public.subscriptions (owner_id, origin, destination, depart_date, email);

-- 列表查询：按 owner 取、最新的排前面
create index if not exists subscriptions_owner_created_idx
  on public.subscriptions (owner_id, created_at desc);

-- Cron 每天扫「该比价的」：只扫 active 的。部分索引，比全表索引小得多。
-- ⭐ status 多了 'expired' 之后这条索引更有价值：过期的行自动退出索引，
--    Cron 的扫描成本只跟「还在盯的订阅数」有关，不会随历史积累变慢。
create index if not exists subscriptions_active_idx
  on public.subscriptions (status, depart_date)
  where status = 'active';


-- ── 升级：status 增加 'expired'（老库跑这一段，幂等）──────────────────
--  为什么不每次查询时按 depart_date < 今天 现算：
--    ① 状态只有一个定义处。列表页、Cron、将来的导出各算一遍，早晚有人写成 <=、
--       或者忘了时区 —— 判据边界漂移的坑已经踩过一次；
--    ② 上面那个部分索引只收 active，标成 expired 的行自动退出索引。
--  谁来标记（三处，口径完全一致，都按 depart_date < 东八区今天）：
--    ① 每次读「我的订阅」列表时顺手标 —— api/_expire.js 的 markExpiredRows()，
--       用户打开页面那一刻看到的就是真状态；没有过期行时一次写都不发；
--    ② Cron 每天扫一次（待实现）—— 兜住「没人打开页面」的情况；
--    ③ 下面这条回填 —— 只负责清存量（老库补跑一次即可）。
--  ⚠️ 三处必须共用同一个「今天」的定义（_expire.js 的 todayShanghai()），
--     各写一份迟早会差一天。
--
--  ⚠️「今天」必须用 Asia/Shanghai，不能用 current_date ——
--     数据库在 UTC，本地 00:00~08:00 那段时间 UTC 还停在前一天，口径会差一天。
alter table public.subscriptions
  drop constraint if exists subscriptions_status_check;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active', 'paused', 'expired'));

-- 回填：出发日已过的、还没标 expired 的，一次性标掉。幂等。
-- ★ 为什么 paused 也一起标：用户暂停的是一条「还会飞」的监控。航班已经飞走了，
--   这条监控同样作废；留着 paused 会永远挂在列表里显示「已暂停」，比「已过期」更误导。
update public.subscriptions
   set status     = 'expired',
       updated_at = now()
 where status in ('active', 'paused')
   and depart_date < (now() at time zone 'Asia/Shanghai')::date;


-- ── 表二：通知流水 ────────────────────────────────────────────────────
--  ★ 通知流水是「已经发生过的事」的记录，不依附订阅而存在。
--    所以：
--      · subscription_id 可空，外键用 on delete set null —— 取消订阅**不会**删掉历史记录，
--        只是把这一行的「来源订阅」置空（那封邮件确实发过了，不能因为取消订阅就当没发生）
--      · origin / destination 是写入那一刻的**航线快照**。为什么要冗余这一份：
--        航线本来是 join 订阅表拿的，订阅一删就 join 不到了；而且将来若允许改订阅的航线，
--        join 出来的历史记录会跟着变，变成「收到的是 A 航线的邮件，记录里写着 B 航线」。
--        快照 = 事实，写进去就不再动。
create table if not exists public.notify_log (
  id               uuid        primary key default gen_random_uuid(),
  owner_id         text        not null,
  subscription_id  uuid
                   references public.subscriptions (id) on delete set null,
  origin           text,                          -- 航线快照（出发三字码），写入时落库
  destination      text,                          -- 航线快照（到达三字码）
  price            integer     not null,          -- 触发时的价格
  -- hit      = 跌破目标价，用户等到了
  -- deadline = 到了决策截止日还没到价，发一封收尾信
  -- 这张表只有这两类：每张订阅最多各发一封，发完订阅就结束（status→expired）
  kind             text        not null default 'hit'
                   check (kind in ('hit', 'deadline')),
  send_status      text        not null default 'sent'
                   check (send_status in ('sent', 'failed')),
  notified_at      timestamptz not null default now()
);

-- 「我的订阅」页要按时间倒序展示通知历史
create index if not exists notify_log_owner_time_idx
  on public.notify_log (owner_id, notified_at desc);

-- 从订阅侧查流水时用得上
create index if not exists notify_log_subscription_idx
  on public.notify_log (subscription_id);


-- ── 升级：把已存在的 notify_log 改成「记录不随订阅消失」────────────────
--  上面的 create table 带 if not exists，对**已经建好的表**不会做任何改动。
--  所以老库必须靠下面这段补：加两列快照、放开 subscription_id 的 not null、换掉外键。
--  整段幂等，重复执行无害。
--
--  【为什么改外键】原来 on delete cascade —— 取消订阅会把历史通知一起抹掉。
--  那封邮件是真的发出去过的，删订阅表达的是「别再盯了」，不等于那件事没发生。
alter table public.notify_log
  add column if not exists origin      text,
  add column if not exists destination text;

alter table public.notify_log
  alter column subscription_id drop not null;

-- 内联写法时 Postgres 自动起的约束名就是 notify_log_subscription_id_fkey
alter table public.notify_log
  drop constraint if exists notify_log_subscription_id_fkey;

alter table public.notify_log
  add constraint notify_log_subscription_id_fkey
  foreign key (subscription_id) references public.subscriptions (id) on delete set null;

-- 回填：存量的通知记录当初只有 subscription_id，航线靠 join 现取。现在把订阅的航线抄进快照列，
-- 让老记录也变成自足的一行（否则订阅一删，这些行的航线就查不出来了）。
-- 只补空值 ⇒ 幂等；已经写好快照的行不动。
-- ⚠️ 这里抄的是订阅**当前**的航线，不是发信当时的 —— 当时没记，无从还原。
--    目前订阅的航线不可修改（PATCH 白名单只有阈值/邮箱/截止日/状态），所以两者一致。
update public.notify_log l
   set origin      = s.origin,
       destination = s.destination
  from public.subscriptions s
 where l.subscription_id = s.id
   and (l.origin is null or l.destination is null);

-- 升级：notify_log 增加 kind（区分「命中信」和「到期信」）
--  老记录全部补成 'hit'（当初只有跌破目标价这一种通知），所以 default 直接给 hit。
--  为什么不只靠 default：default 只作用于**新写入的行**，已有行还是 null，
--  而 kind 是 not null 列且 Cron 要按它做幂等判断，null 会让判断失效。
alter table public.notify_log
  add column if not exists kind text not null default 'hit';

alter table public.notify_log
  drop constraint if exists notify_log_kind_check;

alter table public.notify_log
  add constraint notify_log_kind_check
  check (kind in ('hit', 'deadline'));


-- 升级：subscriptions 增加 last_checked_at（「上次比价时间」，老库跑这一段，幂等）
--  allow null 是必须的：老数据没有任何「比价时间」可补，硬填 now() 就是编造。
--  前端遇到 null 会退回显示「订阅时的价格」，不会把 current_price 说成新抓的。
alter table public.subscriptions
  add column if not exists last_checked_at timestamptz;


-- ── 表三：用户配置 ────────────────────────────────────────────────────
--  存「默认通知邮箱」与「邮件开关」。原来放在浏览器 localStorage，
--  问题是换浏览器就没了，而且**将来 Cron 在服务端跑、读的是数据库** ——
--  这份配置必须落库，否则订阅时带的邮箱只在本机有效。
--
--  ★ 为什么 owner_id 是主键（而不是像 subscriptions 那样用 id + 索引）：
--    这是「一人一行」的配置表，upsert 天然按 owner_id 覆盖，不需要第二条记录。
create table if not exists public.user_settings (
  owner_id        text        primary key,   -- 暂无登录，固定 'owner'；接登录后换成真实 user_id
  email           text,                       -- 默认通知邮箱，可为空（未设置）
  notify_enabled  boolean     not null default true,  -- 邮件总开关
  updated_at      timestamptz not null default now()
);


-- ── 表四：查询日志（用于「本月查询次数」）──────────────────────────────
--  ★ 为什么是「日志表」而不是 user_settings 上的一个计数列：
--    计数列答不了「这个月」—— 跨月得写定时任务把它归零，多一个会忘的环节；
--    日志表按 queried_at 一过滤自然就是本月，**不需要任何维护**。
--    代价是行数会涨（每天几十行，可忽略）。
create table if not exists public.query_log (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    text        not null,
  queried_at  timestamptz not null default now()
);

-- 「本月查了几次」= 按 owner 过滤 + 时间范围，这个索引正好覆盖
create index if not exists query_log_owner_time_idx
  on public.query_log (owner_id, queried_at desc);


-- ── 表五：Cron 运行流水 ────────────────────────────────────────────────
--  ★ 为什么必须有（10-26 踩的坑）：cron 原来唯一的输出是 console.log，
--    而 Vercel 免费版日志只留 30 分钟。于是「压根没被调度 / 鉴权 500 / 抓价抛错 /
--    60s 被掐断」四种完全不同的故障在库里长得**一模一样**（什么都没变），
--    排查只能靠猜 —— 这次就猜错了一轮（以为是阈值没命中，实际是 CRON_SECRET 没配）。
--
--  用法：每次运行**进来先插一条**（只写 ran_at + dry），跑完再补 finished_at / ok / summary。
--    · 有 ran_at、finished_at 为空  → 跑起来了但被平台超时掐断
--    · 连行都没有                  → 压根没被调度，或在写库之前就 500（鉴权/环境变量）
--    · ok = false + note            → 半路抛错，原因在 note；summary 为空表示没走到业务逻辑
--  ★ 这条记录**不回答**「今天比了几条价」这类业务问题（那看 subscriptions.last_checked_at），
--    它只回答「这一轮到底有没有跑、跑完了没」。
create table if not exists public.cron_log (
  id          uuid        primary key default gen_random_uuid(),
  ran_at      timestamptz not null default now(),
  finished_at timestamptz,                  -- 空 = 这一轮没跑完（超时被掐断 / 进程被杀）
  ok          boolean,                      -- 空 = 没跑完，无从判断
  dry         boolean     not null default false,
  summary     jsonb,                        -- 跑完时由 handler 写入的统计（checked/hit/failed…）
  note        text                          -- 失败原因（整轮抛错 / 缺 MAIL_* 之类）
);

-- 排查时永远是「看最近几条」，按时间倒序的索引正好覆盖
create index if not exists cron_log_ran_at_idx
  on public.cron_log (ran_at desc);



-- ══════════════════════════════════════════════════════════════════════
--  权限（这一段不能省）
-- ══════════════════════════════════════════════════════════════════════
--  Supabase 从 2026-05-30 起改了默认行为：新项目里 public schema 的新表
--  不再自动开放给 Data API，必须显式授权。不写这段，接口一调就报
--  42501 permission denied。
--
--  我们只从后端用 secret key（等价旧的 service_role）访问，
--  前端永远不直连数据库 —— 所以只给 service_role 授权，其它角色一律不给。
grant usage on schema public to service_role;
grant all on table public.subscriptions to service_role;
grant all on table public.notify_log to service_role;
grant all on table public.user_settings to service_role;
grant all on table public.query_log to service_role;
grant all on table public.cron_log to service_role;

-- 开启行级安全（RLS）但不写任何 policy：
--   → service_role 带 BYPASSRLS，后端读写不受影响
--   → anon / authenticated 完全访问不了，等于给数据库加了一层「外部无门」
-- 将来若改成前端直连 Supabase（用 Supabase Auth），那时再补 policy。
alter table public.subscriptions enable row level security;
alter table public.notify_log enable row level security;
alter table public.user_settings enable row level security;
alter table public.query_log enable row level security;
alter table public.cron_log enable row level security;


-- ══════════════════════════════════════════════════════════════════════
--  验证：跑完这段应该看到五张表都返回 0 或更多
-- ══════════════════════════════════════════════════════════════════════
-- select count(*) as subscriptions_rows from public.subscriptions;
-- select count(*) as notify_log_rows    from public.notify_log;
-- select count(*) as user_settings_rows from public.user_settings;
-- select count(*) as query_log_rows     from public.query_log;
-- select count(*) as cron_log_rows      from public.cron_log;
