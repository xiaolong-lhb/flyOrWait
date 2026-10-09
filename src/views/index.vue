<script setup>
import { RouterLink, RouterView } from 'vue-router';

// 功能 tab：常驻在顶部，点击只切换下方内容区
const navs = [
  { to: '/', label: '查询航班' },
  { to: '/mySubscribtion', label: '我的订阅' },
  { to: '/setting', label: '设置' },
];
</script>

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
        <RouterLink v-for="n in navs" :key="n.to" :to="n.to">{{ n.label }}</RouterLink>
      </nav>
    </header>

    <!-- 内容区：随子路由切换 -->
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

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
/* 当前 tab 高亮：底色 + 阴影（精确匹配，避免 "/" 在所有子页都高亮） */
.nav a.router-link-exact-active {
  color: #2f6bff;
  font-weight: 600;
  background: #eef3ff;
}

/* 内容区 */
.content {
  flex: 1;
}
</style>
