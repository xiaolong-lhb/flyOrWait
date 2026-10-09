<template>
  <div class="discovery">
    <!-- 引导文案 -->
    <div class="hero">
      <h1 class="slogan">现在买，还是再等等？</h1>
      <p class="sub">AI 帮你分析实时票价与整月趋势，告诉你什么时候买风险最小。</p>
    </div>

    <!-- 查询表单：下一步实现 -->
    <div class="query-slot">查询表单待实现</div>
  </div>
</template>

<style scoped>
.discovery {
  max-width: 960px;
  margin: 0 auto;
  padding: 64px 24px;
}

.hero {
  margin-bottom: 40px;
  text-align: center;
}
.slogan {
  margin-bottom: 14px;
  font-size: 36px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #1a2233;
}
.sub {
  font-size: 16px;
  line-height: 1.8;
  color: #6b7688;
}

.query-slot {
  padding: 48px;
  text-align: center;
  color: #9aa5b5;
  background: #fff;
  border: 1px dashed #dfe5ee;
  border-radius: 16px;
}
</style>
