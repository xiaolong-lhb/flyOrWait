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
  ],
});

export default router;
