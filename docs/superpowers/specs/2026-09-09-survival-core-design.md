# 生存核心链：血量 / 饥饿 / 疾跑

日期：2026-09-09
项目：`minecraft-web/`（网页版我的世界，Three.js）
本轮范围：血量、饥饿、疾跑、苹果食物、摔落与溺水伤害、死亡重生、HUD
明确不做：生物、装备护甲、攻击、其他食物、死亡掉落（下一轮）

---

## 1. 目标

让"生存"这件事成立。现在玩家无敌、不会饿，疾跑只是单纯加速，血量不存在。
本轮把原版那套互相咬合的数值接起来：疾跑消耗饥饿 → 饥饿决定回血还是掉血 → 摔落和溺水扣血 → 吃苹果补饥饿。

完成标准（可验证）：

1. 站着不动 20 秒，饥饿不下降；疾跑 20 秒，饥饿明显下降
2. 从 6 格高跳下，落地瞬间扣 3 点血（1.5 颗心）
3. 饥饿调到 0，血量每 4 秒掉 1 点，掉到 1 点停住不饿死
4. 饥饿 20 且满血以下，每 4 秒回 1 点血
5. 右键吃苹果，饥饿 +4，苹果从背包消失
6. 血量归零，玩家回到出生点、满血满饥饿、背包保留
7. HUD 显示 10 颗心和 10 个鸡腿，与血量/饥饿数值一致

---

## 2. 架构

拆成 4 个各管一件事的单元，不互相伸手进内部：

| 单元 | 文件 | 职责 |
|---|---|---|
| 生存状态机 | `js/survival.js`（新建） | 持有 health/hunger/saturation/exhaustion/air，负责 tick、消耗、回血扣血、伤害入口、死亡判定 |
| 玩家物理 | `js/player.js` | 只上报"这一帧做了什么"（移动了多少米、跳没跳、离地多高、眼睛在不在水里），不碰数值 |
| 游戏装配 | `js/main.js` | 把 player 的行为喂给 survival，处理重生和吃食物，刷新 HUD |
| HUD 展示 | `js/hud.js`（新建） + `index.html` + `css/style.css` | 只读 survival 的数值渲染图标，不参与计算 |

**为什么单独建 `survival.js`**：血量/饥饿这套数值下一轮要接生物伤害和护甲减伤，塞进 `player.js` 会让那个文件既管碰撞又管数值，改起来容易互相踩。单独放后，`takeDamage(amount, source)` 是唯一入口，下轮减伤只要在这一处加系数。

**为什么单独建 `hud.js`**：现在 `ui.js` 已经 388 行管背包和合成，再塞血条进去会更难读。

---

## 3. 数据模型

`Survival` 类字段：

```
health        0-20    默认 20（10 颗心）
hunger        0-20    默认 20（10 个鸡腿）
saturation    0-20    默认 5（隐藏值，吃食物先扣它）
exhaustion    0-4     默认 0（累积到 4 就扣 1 点饥饿）
airSupply     0-15    默认 15（秒，水下空气）
regenTimer    秒      回血计时
starveTimer   秒      饿伤计时
drownTimer    秒      溺水伤害计时
dead          bool
```

常量（全部照原版）：

```
MAX_HEALTH = 20
MAX_HUNGER = 20
EXHAUSTION_MAX = 4       满 4 扣 1 饥饿
AIR_MAX = 15             秒
FALL_SAFE = 3            安全下落高度（格）
REGEN_INTERVAL = 4       秒 / 点
STARVE_INTERVAL = 4      秒 / 点
STARVE_MIN_HEALTH = 1    饿不死，最低留 1 点
DROWN_INTERVAL = 1       秒（溺水伤害间隔）
DROWN_DAMAGE = 2         每次溺水伤害量
REGEN_MIN_HUNGER = 18    饥饿 ≥18 才回血
SPRINT_MIN_HUNGER = 7    饥饿 ≥7 才允许疾跑
```

### 消耗度（exhaustion）对照表

| 行为 | 数值 |
|---|---|
| 走路 | 0.01 / 米 |
| 疾跑 | 0.1 / 米 |
| 潜行 | 0.005 / 米 |
| 游泳 | 0.015 / 米 |
| 跳跃 | 0.05 / 次 |
| 疾跑跳跃 | 0.2 / 次 |
| 破坏方块 | 0.005 / 次 |
| 受到伤害 | 0.1 / 次 |

结算：`exhaustion >= 4` 时 `exhaustion -= 4`，然后若 `saturation >= 1` 则 `saturation -= 1`，否则 `hunger = max(0, hunger - 1)`。

### 回血与饿伤

- 回血：`hunger >= 18` 且 `health < 20` 时，每 4 秒 `health += 1` 且 `exhaustion += 6`
- 饿伤：`hunger == 0` 时，每 4 秒 `health -= 1`，但 `health` 不低于 1
- 溺水：`airSupply` 归零后，每 1 秒 `health -= 2`
- 摔落：落地时 `damage = ceil(fallDistance - 3)`，`fallDistance > 3` 才生效

（实现时改了两处：`floor` 改 `ceil`，因为落地帧 `pos.y` 不会精确到整格，实测从 6 格落下 `fallDistance = 5.9`，`floor(5.9)-3 = 2` 会少扣 1 点；`ceil(5.9-3) = 3` 才对，也和原版一致。另外落地时的高度取 `max(累积 fallDistance, lastGroundY - 落地后 pos.y)`，用实际落点算更准。）

### 伤害入口

统一走 `takeDamage(amount)`：
- 扣血（不低于 0）
- `exhaustion += 0.1`
- `health <= 0` 时置 `dead = true`

下轮接护甲时，只需在这里乘一个减伤系数，其余逻辑不动。

---

## 4. 各系统细节

### 4.1 疾跑

已有基础（`player.js` 里 `SPRINT = 5.612`、`input.sprint`、Ctrl 键绑定）。本轮补三件事：

1. **门槛**：`hunger > 6` 才能疾跑，否则自动退回走路速度
2. **消耗**：移动时按上表累加 exhaustion（走/疾跑/潜行/游泳用同一个"移动了多少米"的输入）
3. **FOV 拉伸**：疾跑时相机 FOV 从 72 平滑过渡到 80（原版约 +11%），松开平滑回落。用 `lerp` 每帧插值，不要突变

飞行模式（`player.flying`）下不计算消耗、不触发摔落。

### 4.2 摔落

`player.js` 每帧上报 `fallDistance`：

- 在地面时：`fallDistance = 0`
- 离地且 `vel.y < 0` 时：`fallDistance = max(fallDistance, lastGroundY - pos.y)`
- 落地那一帧：把 `fallDistance` 交给 survival 结算，然后归零

注意：`spawnPlayer()` 和 `respawn()` 改完 `pos` 后**必须同步 `lastGroundY = pos.y`**。否则 `lastGroundY` 还留着构造函数里的 `80`，玩家一进游戏就会被判定为"从 80 格高处摔下"直接摔死（实测踩过这个坑）。

注意：落进水里不算摔落伤害（原版行为），落地前先判断落点是不是水。

### 4.3 溺水

`player.js` 已有 `checkWater()` 和 `inWater`。本轮额外判断**眼睛**是否在水里（用 `eyePos()` 取眼高那格的方块）。

- 眼睛在水里：`airSupply -= dt`，归零后开始扣血
- 眼睛离开水：`airSupply` 恢复到 15
- 飞行或创造模式下不扣

### 4.4 苹果

- 新增物品 `apple`，贴图 `textures/item/apple.png`（原版）
- 破坏**橡树树叶**时有 5% 概率额外掉落 1 个苹果（原版行为）
- 右键**优先级**：手持可食用物品且 `hunger < 20` 时，右键吃掉，不触发放置
- 饥饿已满（20）时右键无事发生（苹果没有方块形态，本来也放不了）
- 出生时额外给 3 个苹果，保证前几分钟饿不死

### 4.5 死亡与重生

- `health <= 0` → `dead = true`，暂停玩家输入
- 显示死亡提示层（复用现有的 `#screen`/`#panel` 结构），给一个"重生"按钮
- 重生：传送回出生点（`spawnPlayer()` 已存在的逻辑）、`health=20`、`hunger=20`、`saturation=5`、`exhaustion=0`、`airSupply=15`
- **本轮不掉背包物品**（下轮生物和装备一起做掉落规则）

### 4.6 HUD

新增 6 张原版图标到 `textures/hud/`：

| 文件 | 来源路径（1.20.4） |
|---|---|
| `heart_container.png` | `gui/sprites/hud/heart/container.png` |
| `heart_full.png` | `gui/sprites/hud/heart/full.png` |
| `heart_half.png` | `gui/sprites/hud/heart/half.png` |
| `food_empty.png` | `gui/sprites/hud/food_empty.png` |
| `food_full.png` | `gui/sprites/hud/food_full.png` |
| `food_half.png` | `gui/sprites/hud/food_half.png` |

（顺带记一下：下轮护甲图标是 `hud/armor_empty.png` / `armor_full.png` / `armor_half.png`，同目录，已验证可下载。）

布局：在 `#hud` 里新增 `#health-bar`（10 个心形 div）和 `#hunger-bar`（10 个鸡腿 div），放在快捷栏上方，血量靠左、饥饿靠右，与快捷栏同一水平线居中对称（原版布局）。

每个图标 18×18px（原版 9×9 放大 2 倍），CSS 用 `image-rendering: pixelated` 保持像素风。

渲染规则（以血量为例，`i` 从 0 到 9）：

```
v = health - i * 2
v >= 2  → full
v == 1  → half
v <= 0  → container
```

饥饿同理。只在数值变化时更新 DOM，不要每帧重建（现在 `ui.render()` 已经够频繁了）。

---

## 5. 文件改动清单

| 文件 | 改动 |
|---|---|
| `js/survival.js` | 新建，生存状态机（约 120 行） |
| `js/hud.js` | 新建，血量/饥饿条渲染（约 60 行） |
| `js/player.js` | 每帧上报移动距离、跳跃、fallDistance、眼睛是否在水里；疾跑加饥饿门槛 |
| `js/main.js` | 装配 survival、FOV 插值、挖掘消耗、吃食物、死亡重生、HUD 刷新 |
| `js/items.js` | 新增 `apple` 物品及其可食用属性 |
| `js/blocks.js` | 树叶掉落表加苹果（5%） |
| `index.html` | 新增 `#health-bar` / `#hunger-bar` 容器；开始界面补苹果和生存说明 |
| `css/style.css` | HUD 图标样式 |
| `textures/hud/*.png` | 新增 6 张 |
| `textures/item/apple.png` | 新增 1 张 |

`js/textures.js` 的方块图集**不动**（HUD 图标直接用 `<img>`/CSS background，不进图集）。

---

## 6. 验证方式

模型看不了图片，所以全部用数值断言 + 像素统计（沿用已有做法：CDP 无头 Chrome + 手动解 PNG）。

1. **数值断言**：在无头浏览器里直接改 `game.survival` 的字段，跑若干秒后读回
   - 疾跑消耗：设置 `hunger=20`，疾跑 20 秒，断言 hunger 下降
   - 摔落：把玩家放到 y+6 自由落体，落地后断言 `health == 17`
   - 饿伤：设 `hunger=0`，等 9 秒，断言 `health` 掉了 2 点且不低于 1
   - 回血：设 `hunger=20, health=10`，等 9 秒，断言 `health` 涨了 2 点
   - 吃苹果：给 1 个苹果，设 `hunger=10`，右键，断言 `hunger == 14`
2. **HUD 像素验证**：截取 HUD 区域，统计红色像素（心形）占比，断言 10 颗心时红像素最多、半血时约一半
3. **回归**：确认 JS 无报错、FPS 不低于 50、原有挖掘/合成/熔炉功能不受影响

---

## 7. 本轮明确不做

- 生物（下一轮：被动 + 敌对）
- 装备栏与护甲减伤（下一轮，`takeDamage` 已预留入口）
- 攻击伤害与击退
- 除苹果外的食物（下一轮随生物加肉类）
- 死亡掉落背包物品
- 药水效果、饥饿"抖动"动画、困难难度饿死
