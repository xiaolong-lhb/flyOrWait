<template>
  <div class="app-shell">
    <!-- 顶部：logo + 功能 tab（始终保留） -->
    <header class="topbar">
      <div class="logo">
        <span class="plane">✈</span>
        <span class="cn">该买机票吗</span>
        <span class="en">FlyOrWait</span>
      </div>
      <nav class="nav">
        <RouterLink v-for="n in navs" :key="n.to" :to="tabTarget(n)" :class="{ on: isActive(n) }">{{
          n.label
        }}</RouterLink>
      </nav>
    </header>

    <!-- 内容区：随子路由切换 -->
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

const route = useRoute();

// 功能 tab：常驻在顶部，点击只切换下方内容区
// match 声明「哪些路由名归这个 tab 管」——查询结果页也属于「查询航班」，所以进结果页时这个 tab 仍高亮
const QUERY_TAB = { to: '/', label: '查询航班', match: ['discovery', 'result'] };
const navs = [
  QUERY_TAB,
  { to: '/mySubscribtion', label: '我的订阅', match: ['mySubscribtion'] },
  { to: '/setting', label: '设置', match: ['setting'] },
];

/* ---------------------------------------------------------------------------
 * 「查询航班」tab 的落点记忆
 *   问题：在结果页 → 点「我的订阅」/「设置」→ 再点「查询航班」，会掉回查询表单，
 *        上一次的查询结果就找不回来了。
 *   处理：凡是停留在查询页 / 结果页，就把当时的完整路径记下来；再点「查询航班」
 *        时优先回到那里。记在 sessionStorage，刷新也不丢。
 * ------------------------------------------------------------------------ */
const LAST_PATH_KEY = 'fow:lastQueryPath';
const lastQueryPath = ref(sessionStorage.getItem(LAST_PATH_KEY) || '');

watch(
  () => route.fullPath,
  () => {
    if (QUERY_TAB.match.includes(route.name)) {
      lastQueryPath.value = route.fullPath;
      sessionStorage.setItem(LAST_PATH_KEY, route.fullPath);
    }
  },
  { immediate: true },
);

const isActive = (nav) => nav.match.includes(route.name);

/** 「查询航班」回到上次停留的位置（结果页也算查询航班）；其他 tab 正常跳 */
const tabTarget = (nav) =>
  nav === QUERY_TAB && lastQueryPath.value ? lastQueryPath.value : nav.to;
</script>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f7f9fc;
}

/* 顶部栏 */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 40px;
  background: #fff;
  border-bottom: 1px solid #eef1f5;
}
.logo {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.logo .plane {
  color: #2f6bff;
  font-size: 20px;
}
.logo .cn {
  font-size: 18px;
  font-weight: 800;
  color: #1a2233;
}
.logo .en {
  font-size: 13px;
  font-weight: 500;
  color: #9aa5b5;
}

/* 功能 tab */
.nav {
  display: flex;
  gap: 6px;
}
.nav a {
  padding: 8px 16px;
  border-radius: 10px;
  font-size: 14px;
  color: #4a5568;
  cursor: pointer;
  transition: all 0.2s;
}
.nav a:hover {
  color: #2f6bff;
}
/* 当前 tab 高亮：底色（用 route.name 判断，见 isActive） */
.nav a.on {
  color: #2f6bff;
  font-weight: 600;
  background: #eef3ff;
}

/* 内容区 */
.content {
  flex: 1;
}
</style>
