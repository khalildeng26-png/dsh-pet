/**
 * 菜单放行判定与第三方菜单层级的单元测试。
 *
 * 这两份判据被浏览器与桌面两端共用（桌面经 shared-core 拿到同一份），所以钉在这里，
 * 免得一端改了另一端跟着漂移。
 * 跑法：node --experimental-strip-types --test src/shared/menu/tree.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildMoreBranch, isSleepAllowedAction, readMenuItems } from './tree.ts';

describe('isSleepAllowedAction —— 睡着时仍然放行的动作', () => {
  test('睡觉 / 起来 / 维护类 / 第三方菜单项放行', () => {
    for (const action of ['sleep', 'wake', 'home', 'set-display', 'reload', 'third-party']) {
      assert.equal(isSleepAllowedAction(action), true, action + ' 应放行');
    }
  });

  test('打扰类一律不放行（对话 / 碎碎念 / 余额 / 待办 / 动作点播）', () => {
    for (const action of ['chat', 'whisper', 'show-balance', 'todo']) {
      assert.equal(isSleepAllowedAction(action), false, action + ' 应被拒');
    }
    // 点播动画的叶子只有 anim、没有 action
    assert.equal(isSleepAllowedAction(undefined), false);
  });
});

describe('buildMoreBranch —— 「更多」：label 唯一平铺，重名收进 owner 子菜单', () => {
  test('没有第三方项 → null（菜单里不出现空的「更多」）', () => {
    assert.equal(buildMoreBranch([]), null);
  });

  test('label 全局唯一 → 直接平铺在「更多」下，顺序 = 注册顺序', () => {
    const items = [
      { owner: '状态桥', label: '今日积分' },
      { owner: '小游戏', label: '弹弓' },
    ];
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [
        { label: '今日积分', action: 'third-party', owner: '状态桥' },
        { label: '弹弓', action: 'third-party', owner: '小游戏' },
      ],
    });
  });

  test('label 重名 → 每个 owner 在「更多」下各占一个子菜单，子项仍是原 label', () => {
    const items = [
      { owner: '插件A', label: '签到' },
      { owner: '插件B', label: '签到' },
    ];
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [
        { label: '插件A', children: [{ label: '签到', action: 'third-party', owner: '插件A' }] },
        { label: '插件B', children: [{ label: '签到', action: 'third-party', owner: '插件B' }] },
      ],
    });
  });

  test('同一 owner 的多个重名项收进同一个子菜单，组内保持注册顺序', () => {
    const items = [
      { owner: '插件A', label: '签到' },
      { owner: '插件B', label: '签到' },
      { owner: '插件A', label: '查积分' },
      { owner: '插件B', label: '查积分' },
    ];
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [
        {
          label: '插件A',
          children: [
            { label: '签到', action: 'third-party', owner: '插件A' },
            { label: '查积分', action: 'third-party', owner: '插件A' },
          ],
        },
        {
          label: '插件B',
          children: [
            { label: '签到', action: 'third-party', owner: '插件B' },
            { label: '查积分', action: 'third-party', owner: '插件B' },
          ],
        },
      ],
    });
  });

  test('唯一项与重名项混合：唯一项平铺，重名项才进 owner 子菜单', () => {
    const items = [
      { owner: '插件A', label: '签到' },
      { owner: '小游戏', label: '弹弓' },
      { owner: '插件B', label: '签到' },
    ];
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [
        { label: '插件A', children: [{ label: '签到', action: 'third-party', owner: '插件A' }] },
        { label: '弹弓', action: 'third-party', owner: '小游戏' },
        { label: '插件B', children: [{ label: '签到', action: 'third-party', owner: '插件B' }] },
      ],
    });
  });

  test('重名判定用端过滤之后的结果：本端只有一条时不该被另一端拖进子菜单', () => {
    const data = {
      items: [
        { owner: '插件A', label: '签到', target: 'web' },
        { owner: '插件B', label: '签到', target: 'desktop' },
      ],
    };
    assert.deepEqual(buildMoreBranch(readMenuItems(data, 'desktop')), {
      label: '更多',
      children: [{ label: '签到', action: 'third-party', owner: '插件B' }],
    });
    assert.deepEqual(buildMoreBranch(readMenuItems(data, 'web')), {
      label: '更多',
      children: [{ label: '签到', action: 'third-party', owner: '插件A' }],
    });
  });
});

describe('buildMoreBranch —— [khalil] 定向 owner（分支名@petId）：按宠物分流并收进命名子菜单', () => {
  const items = [
    { owner: '性格@main', label: '傲娇毒舌' },
    { owner: '性格@main', label: '温柔贤惠' },
    { owner: '性格@maid-2', label: '玩梗狂魔' },
    { owner: '小游戏', label: '弹弓' },
  ];

  test('viewerPet 匹配 → 只见本宠物的定向项，收进「性格」子菜单，owner 原串保留', () => {
    assert.deepEqual(buildMoreBranch(items, 'main'), {
      label: '更多',
      children: [
        {
          label: '性格',
          children: [
            { label: '傲娇毒舌', action: 'third-party', owner: '性格@main' },
            { label: '温柔贤惠', action: 'third-party', owner: '性格@main' },
          ],
        },
        { label: '弹弓', action: 'third-party', owner: '小游戏' },
      ],
    });
  });

  test('viewerPet 是另一只 → 它的定向项过滤干净，不残留空分支', () => {
    assert.deepEqual(buildMoreBranch(items, 'maid-2'), {
      label: '更多',
      children: [
        {
          label: '性格',
          children: [{ label: '玩梗狂魔', action: 'third-party', owner: '性格@maid-2' }],
        },
        { label: '弹弓', action: 'third-party', owner: '小游戏' },
      ],
    });
  });

  test('只剩被过滤的定向项 → 整个「更多」为 null', () => {
    assert.equal(buildMoreBranch([{ owner: '性格@main', label: '傲娇毒舌' }], 'maid-2'), null);
  });

  test('不传 viewerPet（老调用方）→ 不过滤，同分支名的定向项并进同一子菜单', () => {
    assert.deepEqual(buildMoreBranch(items), {
      label: '更多',
      children: [
        {
          label: '性格',
          children: [
            { label: '傲娇毒舌', action: 'third-party', owner: '性格@main' },
            { label: '温柔贤惠', action: 'third-party', owner: '性格@main' },
            { label: '玩梗狂魔', action: 'third-party', owner: '性格@maid-2' },
          ],
        },
        { label: '弹弓', action: 'third-party', owner: '小游戏' },
      ],
    });
  });

  test('不带 @ 的 owner 与定向项同 label 重名 → 各走各路：定向项进命名分支，普通项进 owner 分支', () => {
    const mixed = [
      { owner: '性格@main', label: '签到' },
      { owner: '插件A', label: '签到' },
    ];
    assert.deepEqual(buildMoreBranch(mixed, 'main'), {
      label: '更多',
      children: [
        { label: '性格', children: [{ label: '签到', action: 'third-party', owner: '性格@main' }] },
        { label: '插件A', children: [{ label: '签到', action: 'third-party', owner: '插件A' }] },
      ],
    });
  });
});
