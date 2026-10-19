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
--    notify_log     通知流水（每次真的发了降价邮件，追加一条）
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
  status           text        not null default 'active'
                   check (status in ('active', 'paused')),

  cabin            text,                          -- 舱位，可空
  passengers       smallint    not null default 1,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
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

-- Cron 每天扫「该比价的」：只扫 active 的。部分索引，比全表索引小得多
create index if not exists subscriptions_active_idx
  on public.subscriptions (status, depart_date)
  where status = 'active';


-- ── 表二：通知流水 ────────────────────────────────────────────────────
create table if not exists public.notify_log (
  id               uuid        primary key default gen_random_uuid(),
  owner_id         text        not null,
  subscription_id  uuid        not null
                   references public.subscriptions (id) on delete cascade,
  price            integer     not null,          -- 触发时的价格
  send_status      text        not null default 'sent'
                   check (send_status in ('sent', 'failed')),
  notified_at      timestamptz not null default now()
);

-- 「我的订阅」页要按时间倒序展示通知历史
create index if not exists notify_log_owner_time_idx
  on public.notify_log (owner_id, notified_at desc);

-- 订阅被删掉时，它的通知流水一起走（已在外键上写 on delete cascade）；
-- 另外从订阅侧查流水时用得上
create index if not exists notify_log_subscription_idx
  on public.notify_log (subscription_id);


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

-- 开启行级安全（RLS）但不写任何 policy：
--   → service_role 带 BYPASSRLS，后端读写不受影响
--   → anon / authenticated 完全访问不了，等于给数据库加了一层「外部无门」
-- 将来若改成前端直连 Supabase（用 Supabase Auth），那时再补 policy。
alter table public.subscriptions enable row level security;
alter table public.notify_log enable row level security;
alter table public.user_settings enable row level security;
alter table public.query_log enable row level security;


-- ══════════════════════════════════════════════════════════════════════
--  验证：跑完这段应该看到四张表都返回 0 或更多
-- ══════════════════════════════════════════════════════════════════════
-- select count(*) as subscriptions_rows from public.subscriptions;
-- select count(*) as notify_log_rows    from public.notify_log;
-- select count(*) as user_settings_rows from public.user_settings;
-- select count(*) as query_log_rows     from public.query_log;
