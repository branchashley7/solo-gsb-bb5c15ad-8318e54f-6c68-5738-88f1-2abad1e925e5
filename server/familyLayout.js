'use strict';

/**
 * 整谱关系图布局（纯函数，不依赖 Node API，便于测试）。
 *
 * 布局规则（与产品约定一一对应）：
 *   1. 先按**忽略方向**的关系划分连通分量：把父母→子女边视为无向边做连通分块，
 *      没有任何关系的成员各自成为单成员分量；分量按分量内（姓名、ID）最小的成员
 *      做姓名、ID 稳定排序；
 *   2. 各分量分别按**最长父母链**分层：
 *        layer(v) = 无父母 → 0；否则 max(layer(父)) + 1。
 *      图为 DAG（store 保证），记忆化 DFS 必然收敛；
 *   3. 层内排序：
 *        - 没有父母的层（第 0 层）按姓名、ID 排序；
 *        - 其余各层按各成员**直接父母节点横坐标的重心**（父母中心横坐标均值）升序，
 *          重心相等按姓名、ID 稳定排序（自上而下逐层分配，父母总在更低层，坐标已知）；
 *   4. 多位父母指向同一子女：子女只占一个成员节点，每条父母→子女边分别绘制；
 *   5. 同层节点依次占据互不重叠的横向区间（按姓名宽度自适应节点宽，间距固定），
 *      层与层、分量与分量之间保留固定留白，因此节点与姓名互不重叠；
 *   6. 全部坐标为 SVG 用户单位：节点坐标为绝对坐标（相对整张画布），
 *      components[].x/y 给出各分量自身原点，width/height 为整张画布尺寸。
 */

const LAYOUT_METRICS = {
  nodeHeight: 40, // 节点高度（全谱统一）
  nodeMinWidth: 64, // 节点最小宽度
  nodeHPad: 12, // 姓名两侧内边距
  nodeHGap: 26, // 同层相邻节点之间的水平留白
  layerVGap: 64, // 相邻层之间的垂直留白（为跨层曲线与箭头留空间）
  componentGap: 84, // 连通分量之间的垂直留白
  paddingX: 28, // 画布左右内边距
  paddingTop: 66, // 画布顶部留白（放置图名与家谱版本标注）
  paddingBottom: 30, // 画布底部留白
  fontSize: 14, // 节点姓名字号
};

/** 节点宽度按姓名实际显示宽度自适应，保证姓名不会超出节点（也就不会与邻节点重叠） */
function nodeWidthForName(name, metrics = LAYOUT_METRICS) {
  let text = 0;
  for (const ch of String(name || '')) {
    const code = ch.codePointAt(0);
    // 全角字符（CJK 表意文字、假名、谚文、全角标点等）按字身宽度，其余按 0.56 倍估算
    const fullWidth =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    text += fullWidth ? metrics.fontSize : metrics.fontSize * 0.56;
  }
  return Math.max(metrics.nodeMinWidth, Math.ceil(text) + metrics.nodeHPad * 2);
}

function minBy(arr, comparator) {
  return arr.reduce((best, cur) => (comparator(cur, best) < 0 ? cur : best));
}

/**
 * 计算整谱关系图布局。
 *
 * 入参 state：与家族业务相同的状态（members + parentsOf）。
 * 返回：
 *   {
 *     empty, memberCount, edgeCount, componentCount, width, height, metrics,
 *     components: [{
 *       index, x, y, width, height, maxLayer,
 *       nodes: [{ id, name, layer, x, y, width, height }], // 绝对坐标
 *       edges: [{ parentId, childId }],                     // 分量内全部亲子边（不合并）
 *     }],
 *   }
 */
function layoutFamilyGraph(state, metrics = LAYOUT_METRICS) {
  const members = (state && state.members) || [];
  const parentsOfSrc = (state && state.parentsOf) || {};

  const nameById = new Map(members.map((m) => [m.id, m.name]));

  // 边表（防御性过滤：手工改坏数据中的悬空端点不参与布局）
  const allEdges = [];
  for (const [childId, parents] of Object.entries(parentsOfSrc)) {
    if (!nameById.has(childId)) continue;
    for (const parentId of parents) {
      if (nameById.has(parentId)) allEdges.push({ parentId, childId });
    }
  }

  if (members.length === 0) {
    return {
      empty: true,
      memberCount: 0,
      edgeCount: 0,
      componentCount: 0,
      width: 0,
      height: 0,
      metrics: { ...metrics },
      components: [],
    };
  }

  // 姓名、ID 稳定比较器
  const cmpNameId = (a, b) => {
    const byName = String(nameById.get(a) ?? '').localeCompare(String(nameById.get(b) ?? ''), 'zh');
    if (byName !== 0) return byName;
    return a.localeCompare(b);
  };

  // ---- 1. 忽略方向的连通分量（无向邻接 + DFS；按成员存储顺序起步，结果再稳定排序） ----
  const undirected = new Map(members.map((m) => [m.id, []]));
  for (const e of allEdges) {
    undirected.get(e.parentId).push(e.childId);
    undirected.get(e.childId).push(e.parentId);
  }
  const seen = new Set();
  const rawComponents = [];
  for (const m of members) {
    if (seen.has(m.id)) continue;
    const ids = [];
    const stack = [m.id];
    seen.add(m.id);
    while (stack.length) {
      const cur = stack.pop();
      ids.push(cur);
      for (const nb of undirected.get(cur) || []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    rawComponents.push(ids);
  }
  rawComponents.sort((ca, cb) => cmpNameId(minBy(ca, cmpNameId), minBy(cb, cmpNameId)));

  const nodeWidth = new Map();
  for (const m of members) nodeWidth.set(m.id, nodeWidthForName(m.name, metrics));

  // ---- 2/3. 各分量内部分层、重心排序、分配坐标（分量局部坐标） ----
  const components = rawComponents.map((ids, index) => {
    const idSet = new Set(ids);

    // 分量内父母邻接（边的两端必在同一分量内）
    const parentsIn = new Map(ids.map((id) => [id, []]));
    for (const e of allEdges) {
      if (idSet.has(e.childId)) parentsIn.get(e.childId).push(e.parentId);
    }

    // 最长父母链分层（DAG 上记忆化 DFS）
    const layerMemo = new Map();
    const layerOf = (id) => {
      if (layerMemo.has(id)) return layerMemo.get(id);
      const ps = parentsIn.get(id);
      const layer = ps.length === 0 ? 0 : Math.max(...ps.map(layerOf)) + 1;
      layerMemo.set(id, layer);
      return layer;
    };

    const byLayer = new Map();
    for (const id of ids) {
      const l = layerOf(id);
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(id);
    }
    const maxLayer = Math.max(...byLayer.keys());
    const layers = [];
    for (let l = 0; l <= maxLayer; l += 1) layers.push(byLayer.get(l) || []);

    // 各层占位宽度只取决于成员宽度（与层内顺序无关），据此先算出层偏移与分量宽
    const layerWidthOf = (arr) =>
      arr.reduce((sum, id) => sum + nodeWidth.get(id), 0) +
      (arr.length - 1) * metrics.nodeHGap;
    const layerWidths = layers.map(layerWidthOf);
    const contentWidth = Math.max(...layerWidths);
    const contentHeight = maxLayer * (metrics.nodeHeight + metrics.layerVGap) + metrics.nodeHeight;

    // 自上而下逐层排序并分配横坐标；中心横坐标供下一层重心排序使用
    const centerX = new Map();
    const nodes = [];
    for (let l = 0; l <= maxLayer; l += 1) {
      let ordered;
      if (l === 0) {
        // 没有父母的层：姓名、ID 排序
        ordered = [...layers[l]].sort(cmpNameId);
      } else {
        // 按直接父母节点横坐标重心排序，平局按姓名、ID 稳定排序
        ordered = layers[l]
          .map((id) => {
            const ps = parentsIn.get(id);
            const barycenter =
              ps.reduce((sum, p) => sum + centerX.get(p), 0) / ps.length;
            return { id, barycenter };
          })
          .sort((x, y) => x.barycenter - y.barycenter || cmpNameId(x.id, y.id))
          .map((item) => item.id);
      }
      let cursor = (contentWidth - layerWidths[l]) / 2; // 各层相对分量居中
      for (const id of ordered) {
        const w = nodeWidth.get(id);
        nodes.push({
          id,
          name: nameById.get(id),
          layer: l,
          x: cursor,
          y: l * (metrics.nodeHeight + metrics.layerVGap),
          width: w,
          height: metrics.nodeHeight,
        });
        centerX.set(id, cursor + w / 2);
        cursor += w + metrics.nodeHGap;
      }
    }

    const edges = allEdges
      .filter((e) => idSet.has(e.childId))
      .map((e) => ({ parentId: e.parentId, childId: e.childId }))
      .sort((a, b) =>
        a.childId === b.childId
          ? a.parentId.localeCompare(b.parentId)
          : a.childId.localeCompare(b.childId),
      );

    return {
      index,
      x: 0,
      y: 0,
      width: contentWidth,
      height: contentHeight,
      maxLayer,
      nodes,
      edges,
    };
  });

  // ---- 4. 分量之间纵向留白、各自相对整图居中，换算为绝对坐标 ----
  const globalWidth = Math.max(...components.map((c) => c.width));
  let cursorY = metrics.paddingTop;
  for (const c of components) {
    const dx = metrics.paddingX + (globalWidth - c.width) / 2;
    c.x = dx;
    c.y = cursorY;
    for (const n of c.nodes) {
      n.x += dx;
      n.y += cursorY;
    }
    cursorY += c.height + metrics.componentGap;
  }
  cursorY -= metrics.componentGap; // 最后一个分量之后不留分量间距

  return {
    empty: false,
    memberCount: members.length,
    edgeCount: allEdges.length,
    componentCount: components.length,
    width: metrics.paddingX * 2 + globalWidth,
    height: cursorY + metrics.paddingBottom,
    metrics: { ...metrics },
    components,
  };
}

module.exports = {
  LAYOUT_METRICS,
  nodeWidthForName,
  layoutFamilyGraph,
};
