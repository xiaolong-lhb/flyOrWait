/**
 * Agent 事件的日志出口 —— 两个接口共用同一份格式
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么单独一个文件
 * ══════════════════════════════════════════════════════════════════════
 *  api/agent.js（一次性返回）和 api/agent-stream.js（SSE）跑的是**同一个**
 *  runAgent，事件序列完全一样。如果各自实现一份日志，同一次 run 在两种
 *  接口下打出来的行会长得不一样（一个带「第 N 轮」、一个不带），排查时
 *  就得先分清用户用的是哪个接口才能读懂日志 —— 这属于「同一件事有两份
 *  解释」，一定会漂。
 *
 *  为什么放不进 _agentRun.js：
 *    那个文件的约定是**零 console、只抛事件**（见文件头）。日志是消费者
 *    的事，不该让循环本体开始关心「怎么打日志」。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ⚠️ 只打事件名和耗时，**不打 args**
 * ══════════════════════════════════════════════════════════════════════
 *  工具参数里可能有用户填的邮箱（create_subscription_draft）。日志比数据库
 *  更容易被人翻看（`vercel logs` 不需要任何凭据），所以参数一律不进日志。
 */

/**
 * 把一个 runAgent 事件写进日志。
 * @param {{type:string}} ev
 */
export function logAgentEvent(ev) {
  switch (ev.type) {
    case 'round':
      console.log(
        `[agent] 第 ${ev.round} 轮：${ev.wantsTools ? `要调 ${ev.wantsTools} 个工具` : '给出回答'}`,
      );
      break;

    // 与 tool-start 对称：llm-start 在**调用模型之前**抛，用来标记
    // 「这段静默是模型在算，不是卡死了」。round 是模型返回**之后**才抛的，
    // 所以单靠 round 表达不了「正在想」这个进行时。
    case 'llm-start':
      console.log(`[agent] 第 ${ev.round} 轮：调用模型`);
      break;

    case 'tool-start':
      // 只打名字，不打 args（理由见文件头）
      console.log(`[agent]   → ${ev.name} 开始执行`);
      break;

    case 'tool':
      console.log(
        `[agent]   ${ev.name} ${ev.ok ? 'ok' : `✗ ${ev.code}`} ${ev.durationMs}ms` +
          (ev.ok ? '' : ` — ${ev.message}`),
      );
      break;

    case 'llm-error':
      console.error(`[agent] 第 ${ev.round} 轮模型失败：${ev.message}`);
      break;

    case 'db-warn':
      // 记账失败不影响回答，但必须留痕 —— 否则「为什么库里缺了这次 run」永远查不清
      console.warn(`[agent] 落库异常：${ev.message}`);
      break;

    default:
      // 未知事件静默跳过：以后加新事件时，旧接口不该因为不认识它就崩
      break;
  }
}
