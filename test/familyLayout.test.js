'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  layoutFamilyGraph,
  nodeWidthForName,
  LAYOUT_METRICS,
} = require('../server/familyLayout');

/** 测试辅助：批量建成员（id 与姓名相同） */
function makeState(names) {
  const state = { maxMembers: 30, members: [], parentsOf: {} };
  for (const name of names) {
    state.members.push({ id: name, name, birthday: null, deathday: null });
    state.parentsOf[name] = [];
  }
  return state;
}

function add(state, parent, child) {
  state.parentsOf[child].push(parent);
}

function layoutOf(result, id) {
  for (const c of result.components) {
    const n = c.nodes.find((x) => x.id === id);
    if (n) return n;
  }
  return null;
}

function edgeSet(result) {
  const edges = [];
  for (const c of result.components) {
    for (const e of c.edges) edges.push(`${e.parentId}->${e.childId}`);
  }
  return new Set(edges);
}

test('空谱：empty=true、零分量零尺寸', () => {
  const r = layoutFamilyGraph(makeState([]));
  assert.equal(r.empty, true);
  assert.equal(r.componentCount, 0);
  assert.equal(r.memberCount, 0);
  assert.equal(r.edgeCount, 0);
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
  assert.deepEqual(r.components, []);
});

test('无关系成员：各自成为单成员分量，按姓名、ID 排序并纵向排列', () => {
  const r = layoutFamilyGraph(makeState(['C', 'A', 'B']));
  assert.equal(r.empty, false);
  assert.equal(r.componentCount, 3);
  assert.deepEqual(r.components.map((c) => c.nodes[0].id), ['A', 'B', 'C']);
  for (const c of r.components) {
    assert.equal(c.maxLayer, 0);
    assert.deepEqual(c.edges, []);
    assert.equal(c.nodes[0].layer, 0);
  }
  // 分量之间留白且不重叠：后一分量顶部在上一分量底部之下
  for (let i = 1; i < r.components.length; i += 1) {
    const prev = r.components[i - 1];
    const cur = r.components[i];
    assert.ok(cur.y >= prev.y + prev.height + LAYOUT_METRICS.componentGap - 1e-9);
  }
});

test('直线家谱：按最长父母链分层，每层一人', () => {
  const s = makeState(['R', 'A', 'B', 'C']);
  add(s, 'R', 'A');
  add(s, 'A', 'B');
  add(s, 'B', 'C');
  const r = layoutFamilyGraph(s);
  assert.equal(r.componentCount, 1);
  const c = r.components[0];
  assert.equal(c.maxLayer, 3);
  assert.deepEqual(c.nodes.map((n) => [n.id, n.layer]), [
    ['R', 0],
    ['A', 1],
    ['B', 2],
    ['C', 3],
  ]);
  assert.deepEqual([...edgeSet(r)].sort(), ['A->B', 'B->C', 'R->A']);
});

test('钻石结构：两位父母指向同一子女只占一个节点，两条边都保留', () => {
  const s = makeState(['R', 'A', 'B', 'D']);
  add(s, 'R', 'A');
  add(s, 'R', 'B');
  add(s, 'A', 'D');
  add(s, 'B', 'D');
  const r = layoutFamilyGraph(s);
  assert.equal(r.componentCount, 1);
  const c = r.components[0];
  // D 在第 2 层，且全图只出现一次
  const d = c.nodes.filter((n) => n.id === 'D');
  assert.equal(d.length, 1);
  assert.equal(d[0].layer, 2);
  assert.deepEqual([...edgeSet(r)].sort(), ['A->D', 'B->D', 'R->A', 'R->B']);
});

test('层内重心排序：子女按直接父母横坐标重心排，平局按姓名、ID', () => {
  // 共同始祖 R → P1/P2（第 1 层按姓名 P1 在左、P2 在右）→ CL/CR（第 2 层）；
  // 第 3 层：Y 父母为左支 CL（重心靠左），X 父母为右支 CR（重心靠右）→ Y 在 X 左侧。
  const s = makeState(['R', 'P1', 'P2', 'CL', 'CR', 'Y', 'X']);
  add(s, 'R', 'P1');
  add(s, 'R', 'P2');
  add(s, 'P1', 'CL');
  add(s, 'P2', 'CR');
  add(s, 'CL', 'Y');
  add(s, 'CR', 'X');
  const r = layoutFamilyGraph(s);
  const layer3 = r.components[0].nodes.filter((n) => n.layer === 3);
  assert.deepEqual(layer3.map((n) => n.id), ['Y', 'X']);
});

test('重心相同时按姓名、ID 稳定排序', () => {
  // Z 与 W 都是 CL、CR 的共同子女 → 重心完全相同 → 按姓名（W<Z）排
  const s = makeState(['P1', 'P2', 'CL', 'CR', 'Z', 'W']);
  add(s, 'P1', 'CL');
  add(s, 'P2', 'CR');
  add(s, 'CL', 'Z');
  add(s, 'CR', 'Z');
  add(s, 'CL', 'W');
  add(s, 'CR', 'W');
  const r = layoutFamilyGraph(s);
  const layer2 = r.components[0].nodes.filter((n) => n.layer === 2);
  assert.deepEqual(layer2.map((n) => n.id), ['W', 'Z']);
});

test('第 0 层按姓名、ID 排序（同名再按 ID）', () => {
  const s = makeState(['a', 'b']);
  s.members.push({ id: 'id1', name: 'same', birthday: null, deathday: null });
  s.members.push({ id: 'id2', name: 'same', birthday: null, deathday: null });
  s.parentsOf.id1 = [];
  s.parentsOf.id2 = [];
  const r = layoutFamilyGraph(s);
  assert.equal(r.componentCount, 4);
  assert.deepEqual(
    r.components.map((c) => c.nodes[0].id),
    ['a', 'b', 'id1', 'id2'],
  );
});

test('忽略方向划分连通分量：有向无关的两块与孤立点分开，分量内按无向连通', () => {
  // 块一：A→B；块二：Y→X；孤立点 Z
  const s = makeState(['A', 'B', 'X', 'Y', 'Z']);
  add(s, 'A', 'B');
  add(s, 'Y', 'X');
  const r = layoutFamilyGraph(s);
  assert.equal(r.componentCount, 3);
  // 分量按其中姓名最小成员排：AB 块（A）、Z、YX 块（X…，最小为 X）
  // 'A' < 'X' < 'Y' < 'Z' → [AB, YX(含X), Z]
  assert.deepEqual(r.components.map((c) => c.nodes.map((n) => n.id).sort()), [
    ['A', 'B'],
    ['X', 'Y'],
    ['Z'],
  ]);
});

test('边方向为「父母→子女」：即使录入顺序相反，分层仍以父母链为准', () => {
  // 先加子女后加父母的录入顺序不影响布局
  const s = makeState(['G', 'F', 'S']);
  add(s, 'F', 'S');
  add(s, 'G', 'F');
  const r = layoutFamilyGraph(s);
  assert.equal(layoutOf(r, 'G').layer, 0);
  assert.equal(layoutOf(r, 'F').layer, 1);
  assert.equal(layoutOf(r, 'S').layer, 2);
});

test('跨层边（一名父母同时是远祖）仍正确分层', () => {
  // G→F→S 且 G→S：S 的最长父母链为 2 层
  const s = makeState(['G', 'F', 'S']);
  add(s, 'G', 'F');
  add(s, 'F', 'S');
  add(s, 'G', 'S');
  const r = layoutFamilyGraph(s);
  assert.equal(layoutOf(r, 'S').layer, 2);
  assert.equal(r.components[0].maxLayer, 2);
  assert.equal(edgeSet(r).size, 3);
});

test('同层节点横向不重叠，纵向按层间隔', () => {
  const s = makeState(['P1', 'P2', 'P3', 'C']);
  // 让第 0 层有 3 人（P3 独立但在同一分量需要连通：令 P3→C）
  add(s, 'P1', 'C');
  add(s, 'P2', 'C');
  add(s, 'P3', 'C');
  // 注意每名子女至多 2 位父母是业务校验规则，布局函数本身对 3 位父母也应工作
  const r = layoutFamilyGraph(s);
  const layer0 = r.components[0].nodes.filter((n) => n.layer === 0);
  assert.equal(layer0.length, 3);
  for (let i = 1; i < layer0.length; i += 1) {
    const prev = layer0[i - 1];
    const cur = layer0[i];
    assert.ok(cur.x >= prev.x + prev.width + LAYOUT_METRICS.nodeHGap - 1e-9);
  }
  // 纵向：C 与第 0 层间隔一层高 + 层间距（节点 y 为绝对坐标，含画布顶部留白与分量原点）
  const c = layoutOf(r, 'C');
  const c0 = r.components[0];
  assert.ok(
    Math.abs(
      c.y - (c0.y + LAYOUT_METRICS.nodeHeight + LAYOUT_METRICS.layerVGap),
    ) < 1e-9,
  );
});

test('分量纵向留白且各分量在整图内居中：节点坐标为绝对坐标', () => {
  const s = makeState(['长姓名的成员甲', '乙']); // 两个孤立分量，宽度不同
  const r = layoutFamilyGraph(s);
  assert.equal(r.componentCount, 2);
  const [c0, c1] = r.components;
  assert.ok(c1.y >= c0.y + c0.height + LAYOUT_METRICS.componentGap - 1e-9);
  // 两个分量都相对整图居中
  assert.ok(Math.abs(c0.x + c0.width / 2 - r.width / 2) < 1e-9);
  assert.ok(Math.abs(c1.x + c1.width / 2 - r.width / 2) < 1e-9);
  // 节点绝对坐标 = 分量原点 + 局部坐标
  const n0 = c0.nodes[0];
  assert.ok(Math.abs(n0.x - c0.x) < 1e-9);
  assert.ok(Math.abs(n0.y - c0.y) < 1e-9);
  // 整图尺寸包含边距
  assert.ok(r.width >= LAYOUT_METRICS.paddingX * 2 + c0.width);
});

test('节点宽度随姓名自适应：长姓名节点更宽且不小于最小宽度', () => {
  assert.ok(nodeWidthForName('张三张三张三张三张三张三') > nodeWidthForName('张'));
  const empty = nodeWidthForName('');
  assert.equal(empty, LAYOUT_METRICS.nodeMinWidth);
  const ascii = nodeWidthForName('Abcd');
  const cjk = nodeWidthForName('张三李四');
  assert.ok(cjk > ascii, '相同字数下全角姓名应比半角姓名更宽');
});

test('布局结果确定性：同一输入多次计算坐标一致', () => {
  const make = () => {
    const s = makeState(['R', 'A', 'B', 'D', 'E']);
    add(s, 'R', 'B');
    add(s, 'R', 'A');
    add(s, 'B', 'D');
    add(s, 'A', 'D');
    add(s, 'D', 'E');
    return s;
  };
  const r1 = layoutFamilyGraph(make());
  const r2 = layoutFamilyGraph(make());
  assert.deepEqual(JSON.stringify(r1), JSON.stringify(r2));
});
