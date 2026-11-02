<template>
  <!--
    ⑥ 航班列表（agent 化后的「航班卡」）

    ⚠️ 外层这个 div 只为承载「区块标题 + 表格/空态」两件事，本身不带任何样式：
       原先是 .result 的直接子节点，包一层块级容器不改变任何视觉（上下间距由
       .sec-t 的 margin 与 .sub-card 的 margin-top 决定，都不受影响）。
  -->
  <div class="flights-block">
    <div class="sec-t">航班列表（实时价）</div>

    <!-- 【API】真实实现：SerpApi google_flights（见后端 api/_serp.js）。
         「当天最低」标记用的是 lowest_price 的正确用途：选哪一班，而不是该不该买。
         ⚠️ 列表可能为空（源挂了 / 这天方案都没给价）→ 空着必须说出来，不能无声无息留个空表 -->
    <table v-if="flights.length" class="f">
      <thead>
        <tr>
          <th>航司</th>
          <th>起飞</th>
          <th>时长</th>
          <th>类型</th>
          <th>价格</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="f in flights"
          :key="f.id"
          :class="{ picked: f.id === pickedId }"
          @click="emit('pick', f)"
        >
          <td>{{ f.airline }}</td>
          <td>{{ f.departTime }}</td>
          <td>{{ f.duration }}</td>
          <td>{{ f.stopText }}</td>
          <td class="pr">
            ¥{{ f.price.toLocaleString() }}
            <span v-if="f.isLowest" class="lowest">当天最低</span>
          </td>
          <td>
            <button class="pick" @click.stop="emit('pick', f)">
              {{ f.id === pickedId ? '已盯' : '盯价' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">
      这次没取到航班列表（原因见上方提示）。你仍然可以直接按本条线路的最低价 ¥{{
        lowestPrice.toLocaleString()
      }}
      订阅盯价。
    </div>
  </div>
</template>

<script setup>
/**
 * 航班列表：纯展示 + 一个「盯价」动作。
 *
 * 只有一件事是父组件必须管的 —— 哪一行被盯（pickedId）。
 * 所以这里刻意**不持有状态**：点击只发 pick 事件，选没选中由父组件的 pickedId 决定。
 * 好处是「订阅卡的阈值要不要跟着变」这类联动仍然只写在父组件一处，
 * 不会出现「子组件也存了一份选中态」这种两处真相。
 */
defineProps({
  /** 后端给的航班列表（可能为空数组） */
  flights: { type: Array, default: () => [] },
  /** 当前被盯的航班 id（空串 = 没盯任何一班） */
  pickedId: { type: String, default: '' },
  /** 全列表最低价：列表为空时用它兜底，告诉用户还能按什么价订阅 */
  lowestPrice: { type: Number, default: 0 },
});

const emit = defineEmits(['pick']);
</script>

<style scoped>
/* ---------- 区块标题（本组件自用一份：scoped 样式不跨组件，改成全局会污染其他页面） ---------- */
.sec-t {
  margin: 18px 0 10px;
  font-size: 15px;
  font-weight: 700;
  color: #1f2937;
}

/* ---------- ⑥ 航班列表 ---------- */
table.f {
  width: 100%;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-collapse: separate;
  border-spacing: 0;
  border-radius: 12px;
}
table.f th {
  padding: 11px 14px;
  font-size: 12px;
  font-weight: 600;
  color: #6b7280;
  text-align: left;
  background: #fafbfc;
  border-bottom: 1px solid #eef0f3;
}
table.f td {
  padding: 13px 14px;
  font-size: 14px;
  color: #374151;
  border-bottom: 1px solid #f2f4f7;
}
table.f tbody tr:last-child td {
  border-bottom: 0;
}
table.f tbody tr {
  cursor: pointer;
  transition: background 0.15s;
}
table.f tbody tr:hover {
  background: #fafbff;
}
table.f tbody tr.picked {
  background: #eef3ff;
}
table.f .pr {
  font-weight: 800;
  color: #dc2626;
}
table.f .lowest {
  margin-left: 6px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
  color: #16a34a;
  background: #e9f8ef;
  border-radius: 999px;
  vertical-align: 1px;
}
table.f .pick {
  padding: 6px 14px;
  font-size: 13px;
  color: #2f6bff;
  background: #fff;
  border: 1px solid #c9d6ff;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
table.f .pick:hover {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}
table.f tr.picked .pick {
  color: #fff;
  background: #2f6bff;
  border-color: #2f6bff;
}

/* 航班列表为空时的说明：空着也要有个交代，不留一张空表 */
.empty {
  padding: 18px 16px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #6b7280;
  text-align: center;
  background: #fff;
  border: 1px dashed #e5e7eb;
  border-radius: 12px;
}

/* 「时长」列在窄屏藏起来（其余列足够判断要不要盯） */
@media (max-width: 640px) {
  table.f th:nth-child(3),
  table.f td:nth-child(3) {
    display: none;
  }
}
</style>
