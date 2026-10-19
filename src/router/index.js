import { createRouter, createWebHistory } from 'vue-router';

/**
 * FlyOrWait 路由表（单页面布局）
 *
 * index.vue 是常驻框架：顶部 logo + 功能 tab 始终保留，
 * 下方内容区根据子路由切换：
 *   ''             查询航班（默认页）
 *   result         查询结果（从查询页跳过来，不在 tab 里）
 *   mySubscribtion 我的订阅
 *   setting        设置
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('../views/index.vue'),
      children: [
        {
          path: '',
          name: 'discovery',
          component: () => import('../views/powerTabs/discovery.vue'),
        },
        {
          path: 'result',
          name: 'result',
          component: () => import('../views/powerTabs/result.vue'),
        },
        {
          path: 'mySubscribtion',
          name: 'mySubscribtion',
          component: () => import('../views/powerTabs/mySubscribtion.vue'),
        },
        {
          path: 'setting',
          name: 'setting',
          component: () => import('../views/powerTabs/setting.vue'),
        },
      ],
    },
    {
      // 兜底：任何不存在的路径都送回查询页。
      // 不补这条的话，createWebHistory 下访问错路径匹配不到任何路由，
      // <router-view> 渲染为空 —— 用户看到的是一片纯白，且不知道发生了什么。
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

export default router;
