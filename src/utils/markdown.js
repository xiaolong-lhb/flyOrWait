/**
 * 把模型返回的 markdown 解析成「块」，供模板 v-for 渲染。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么不用 v-html
 * ══════════════════════════════════════════════════════════════════════
 *  v-html + 一个 markdown 库看起来最短，但模型输出是**不可信文本**：
 *  它可能被用户的问题诱导出一段 <img onerror=...>。转义漏一处就是 XSS。
 *  这里把文本切成结构化数据（段落 / 列表 / 粗体 run），模板只做插值
 *  —— Vue 的插值默认转义，HTML 特殊字符天然安全，一行 sanitize 都不用写。
 *
 * ══════════════════════════════════════════════════════════════════════
 *  支持到什么程度，以及为什么正好是这些
 * ══════════════════════════════════════════════════════════════════════
 *  实测一次真实回答（deepseek-flash，2026-11-04）只用到三种语法：
 *      **结论：……**          → 粗体
 *      - 11-27、11-28 ……     → 无序列表
 *      （空行）               → 分段
 *  所以在这些之外只补了三种「出现就会很难看」的：
 *      1. 有序列表            → 模型换个问法就会用
 *      ### 标题               → 不处理会露出三个井号
 *      ``` 代码块             → 不处理会露出三个反引号
 *  再多的语法（表格、链接、图片）**故意不支持**：气泡宽度只有 400px 左右，
 *  表格必然挤成一团；链接和图片则意味着模型在替用户做跳转，不是我们要的。
 *
 *  ⚠️ 未支持的语法会原样显示（比如 `| a | b |` 会露出竖线）——这是有意的：
 *  宁可露出符号，也不要写一个半吊子解析器把它渲染成错的表格。
 */

/** `**加粗**`。不处理 `*斜体*`：中文里星号更多是强调，斜体在气泡里几乎看不出 */
const BOLD = /\*\*([^*]+)\*\*/g;

/**
 * 行内解析：把一行文字切成若干 run。
 * run = { text, bold } —— 模板里 `<span :class="{ b: r.bold }">{{ r.text }}</span>`
 * @param {string} text
 * @returns {Array<{text: string, bold: boolean}>}
 */
function parseInline(text) {
  const runs = [];
  let last = 0;
  let m;
  BOLD.lastIndex = 0;

  while ((m = BOLD.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });

  return runs;
}

/**
 * @param {string} markdown 模型返回的原文
 * @returns {Array<object>} 块数组，每块是 {type:'p'|'ul'|'ol'|'code', ...}
 */
export function toBlocks(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  /** @type {Array<object>} */
  const blocks = [];

  /** 段落缓冲：连续的普通行属于同一段 */
  let para = [];
  /** 正在累积的列表：{type:'ul'|'ol', items: run[][]} */
  let list = null;
  /** 代码块缓冲：非 null 表示正在 ``` 里面 */
  let code = null;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: 'p', runs: parseInline(para.join('\n')) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (const raw of lines) {
    // 代码块优先级最高：里面的 `-` 和 `**` 都不该被当成语法
    if (raw.trim().startsWith('```')) {
      if (code === null) {
        flushAll();
        code = [];
      } else {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(raw);
      continue;
    }

    if (!raw.trim()) {
      flushAll();
      continue;
    }

    const heading = raw.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      // 气泡里出标题会很怪，降级成「一段加粗文字」
      flushAll();
      blocks.push({ type: 'p', runs: [{ text: heading[1].trim(), bold: true }] });
      continue;
    }

    const ul = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(parseInline(ul[1]));
      continue;
    }

    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(parseInline(ol[1]));
      continue;
    }

    // 普通行：列表被打断就收尾
    flushList();
    para.push(raw);
  }

  // 收尾：没闭合的代码块也要显示出来，不能吞掉
  if (code !== null) blocks.push({ type: 'code', text: code.join('\n') });
  flushAll();

  return blocks;
}

export default toBlocks;
