# dsh-auto-email

每天把当天最重要的 **3 条 AI 技术动态** 发到你的邮箱，每条附带一段自己写的解读。

为 [DSH Desktop](https://github.com/) 写的插件，也可以完全脱离 DSH 当命令行工具用。零 npm 依赖，只用 Node 内置模块。

```
采集 10 个信源 → 时间窗过滤 → 事件聚类 → 程序打分 → LLM 排序
      → 主题多样化精选 3 条 → LLM 写四段式解读 → 渲染邮件 → SMTP 投递
```

---

## 它产出什么

一封 HTML 邮件（同时带纯文本兜底），三条，每条包含：

| 部分 | 内容 |
|---|---|
| 中文标题 | 一句话说清「谁 + 做了什么 + 关键数字」，不用英文原标题 |
| 原文标题 | 保留原文，便于你自己去搜 |
| 来源与时间 | 如实标注信源层级（T1/T2/T3）、发布时间、主题簇 |
| 可信度徽章 | 🟢 交叉验证 / 🟡 单一来源 / ⚪ 信息不足，**由程序客观计算，不交给模型编造** |
| 📌 事实 | 只复述原文，不添加原文没有的事实 |
| 🔍 为什么重要 | 机制与因果，不写「AI 将改变一切」式的空话 |
| 🎯 对你的影响 | 一句可操作判断（要不要跟进、等什么信号） |
| ⚖️ 存疑点 | 原文没给全的地方如实说出来 |

解读字数按 **重要性 × 技术新颖度** 自动伸缩：越难越新的写得越长（120–400 字），单纯的融资稿重要性可能高但新颖度低，解读就短。

---

## 安装

### 方式 A：`dsh plugin`（推荐，声明式）

```sh
dsh plugin --profile web add github:X-Xyy/dsh-auto-email
```

包里的 `cordis.patch.yml` 声明了 host 半边的挂载，`package.json` 的 `dsh.bundle` 让 loader 自动应用它 ——
不用手工拷文件、不用改 profile 的 patch 文件。重启（或刷新浏览器页面）后侧边栏面板出现；
卸载是 `dsh plugin --profile web remove dsh-auto-email`。

> 两种安装方式不要同时用：bundle 挂载的 id 是 `dsh-auto-email`，下面本地挂载用的是
> `dsh-auto-email-1`（带缓存破坏后缀），同时存在会让同一个插件被挂两次。

### 方式 B：本地挂载（开发 / 改代码时用）

一条命令（拷贝 + 挂载，幂等，可回滚）：

```powershell
node scripts/install.mjs --mount      # 先加 --dry-run 看它会写哪里
node scripts/install.mjs --unmount    # 卸载：patch 文件恢复到字节级一致
```

它做两件事：把 `package.json` 与 `lib/` 拷到 `%APPDATA%\dsh-desktop\plugins\dsh-auto-email`，
再在 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml` 里维护一个带围栏标记的挂载块
（写之前先备份成 `cordis.patch.yml.bak-<时间戳>`）。

手工等价操作是：

```powershell
$dest = "$env:APPDATA\dsh-desktop\plugins\dsh-auto-email"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item package.json $dest -Force
Copy-Item lib $dest -Recurse -Force
```

```yaml
- insert:
    - id: dsh-auto-email-1
      name: "file:///C:/Users/<你>/AppData/Roaming/dsh-desktop/plugins/dsh-auto-email/lib/index.js"
```

> `-N` 后缀与 `?rev=` 后缀都是给 dsh-hmr 的缓存破坏标记，不是版本号。改了代码又不想重启，就把 `dsh-auto-email-1` 改成 `dsh-auto-email-2` —— `node scripts/install.mjs --mount --rev 2` 会同时改 id 和模块 URL，两者都新才会被重新导入。

然后写凭据文件（见下一节）。挂载后它会出现在插件列表里，
**在插件管理面板里直接开关就是启用/禁用**。host 半边由 dsh-hmr 热加载（`logs/harness.log` 里出现 `auto-email: ready` 即为加载成功）；
browser 半边的侧边栏面板需要刷新一次浏览器页面才会出现。

> ⚠️ 如果你已经在用另一个版本（比如 Python 版 + Windows 任务计划程序）发同一封日报，
> 先把那个停掉再启用这个。两套调度都在跑 = 每天收到两封。

### 从 Python 版接管历史（可选）

如果之前用过本仓库的 Python 版，它的 `seen.json` 记录了已推送过的标题哈希。本插件的哈希算法与它**逐位一致**
（都是「标题归一化后取 sha1 的前 20 位十六进制」），所以可以整库搬过来，不会因为搬家而重发旧新闻：

```powershell
node bin/dsh-auto-email.mjs --migrate <Python 版的 seen.json 路径>
```

合并是**并集**，且刻意保守：已存在的哈希保留更新的日期，`last_sent_date` 只在旧文件更新时才覆盖 ——
取旧了会重发，取新了会漏发，两个方向都不能错。导入**幂等**，第二次运行报告 0 条新增；
导入前把现有 `state.json` 备份成 `state.json.bak-<时间戳>`；只写状态文件，不发信、不动归档。

### 方式 C：命令行 / 任务计划程序

```powershell
node bin/dsh-auto-email.mjs --dry-run -v     # 先干跑看看会选哪三条
node bin/dsh-auto-email.mjs                  # 真发
node bin/dsh-auto-email.mjs --if-due         # 幂等模式，给定时器调用
node bin/dsh-auto-email.mjs --migrate <file> # 并入 Python 版 seen.json
```

Windows 任务计划程序里注册一个每天 08:00 的任务，动作填 `node <仓库路径>\bin\dsh-auto-email.mjs --if-due`。`--if-due` 保证：没到点不发、今天发过就不再发，所以你可以放心把登录、解锁、每 30 分钟轮询都挂上同一个命令，**永远不会重复投递**。

---

## 配置

### 凭据

凭据**不写进配置文件**，单独放一个文件：

`%APPDATA%\dsh-desktop\dsh-auto-email.secret.json`

```json
{
  "deepseek_api_key": "sk-...",
  "smtp_username": "you@qq.com",
  "smtp_auth_code": "你的SMTP授权码",
  "recipients": ["you@qq.com"]
}
```

- `deepseek_api_key` 用 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 Key，也可以用环境变量 `DEEPSEEK_API_KEY`。
- `smtp_auth_code` 是邮箱的 **SMTP 授权码**，不是登录密码。QQ 邮箱在「设置 → 账号 → POP3/SMTP服务」里开启后生成。
- 用非 QQ 邮箱时，改 `email.smtp_host` / `email.smtp_port` / `email.use_ssl` 即可。

检查是否配好：

```powershell
node bin/dsh-auto-email.mjs --status      # 列出所有缺失项
node bin/dsh-auto-email.mjs --send-test   # 只验证 SMTP 登录，不发信
```

### 可调项

改成 DSH 插件选项、或写进 `<userData>\dsh-auto-email\config.json`、或命令行 `--config`。未列出的键用默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `digest.top_n` | `3` | 每封邮件几条 |
| `digest.window_hours` | `26` | 主时间窗（小时）。比 24 多 2 小时，防调度抖动 |
| `digest.fallback_window_hours` | `[48, 72]` | 主窗不够时逐级回溯 |
| `digest.min_importance` | `6` | 重要性门槛。调高＝更挑剔，更容易触发回溯 |
| `schedule.time` | `"08:00"` | 每天推送时刻（`HH:MM`） |
| `schedule.catch_up_hours` | `12` | 错过多久之内还补发。避免补发一份过期新闻 |
| `schedule.enabled` | `true` | 关掉调度，只留手动 |
| `digest.send_when_empty` | `true` | 当天没有任何达标内容时，是否仍发一封「今日无重大动态」 |
| `llm.model` | `"deepseek-chat"` | 排序与解读用的模型 |

---

## 使用

### 对话里的四个工具

| 工具 | 作用 |
|---|---|
| `dsh_auto_email_status` | 今天发了没、下次什么时候发、配置缺什么 |
| `dsh_auto_email_preview` | 只跑一遍看会选哪三条，**不发信、不写状态** |
| `dsh_auto_email_send` | 立即真发一封 |
| `dsh_auto_email_configure` | 临时改条数 / 时间 / 门槛 / 暂停 N 天 |

### 侧边栏面板

设置区上方多一个「每日AI」入口，面板里能看今日状态、点立即发送、临时暂停、直接改配置和凭据、浏览历史归档。

---

## 它是怎么选的

**这一步决定了这东西有没有用**，所以写清楚。

### 信源（10 个，按层级加权）

| 层级 | 权重 | 信源 | 抓取方式 |
|---|---|---|---|
| T1 一手官方 | 1.0 | OpenAI News | RSS |
| T1 | 1.0 | Anthropic News | 页面解析（官方无 RSS） |
| T1 | 1.0 | Google DeepMind Blog | RSS |
| T1 | 1.0 | Hugging Face Blog | hf-mirror 镜像 RSS |
| T1 | 1.0 | arXiv cs.AI/CL/LG/CV | 官方 API |
| T2 权威媒体 | 0.7 | 量子位 | RSS |
| T2 | 0.7 | TechCrunch AI | RSS |
| T2 | 0.7 | MIT Tech Review AI | RSS |
| T2 | 0.7 | Simon Willison | Atom + AI 关键词过滤 |
| T3 社区信号 | 0.4 | Hacker News | Algolia API，≥50 分 |

**刻意不接**：机器之心（全站 WAF，客户端无法绕过）、TLDR AI / The Rundown / Import AI / The Batch 等 Newsletter、AITOP100 / alphaXiv 等聚合器。理由：Newsletter 和聚合器都是对上述 T1/T2 的二次加工，接进来等于把同一件事数两遍，会虚增「交叉验证」的可信度 —— 而交叉验证正是这套东西最硬的抓手。

### 三道闸门

**闸门 1 · 程序打分**（可复现、可审计）

```
0.35 × 信源层级 + 0.25 × min(独立信源数/3, 1) + 0.20 × 时效衰减
  + 0.20 × 影响信号词命中 − 0.15 ×（摘要为空）
```

**闸门 2 · LLM 逐条打分**：重要性 0–10 与技术新颖度 0–10 是两个独立轴。

- 重要性看影响面；新颖度看有没有技术增量 —— 所以融资稿能进（重要），但解读短（不新）。
- 四条硬性扣分：标题党/PR 软文/空洞评论；二手转述（`Quoting X`、`Weekly roundup`）新颖度一律 ≤3；与 AI 技术无关的纯基建/人事/会议预告；**摘要为空的条目重要性 ≤4、新颖度 ≤5，不得进精选**。
- 融合：`final = 0.70 × (0.55×重要性 + 0.45×新颖度)/10 + 0.30 × 程序分`。给程序分留 30% 是故意的 —— 即使 LLM 判偏，也不会选出纯噪音。

**闸门 3 · 精选约束**：主窗内重要性 ≥6 的不足 3 条，就回退 48h、再 72h（**宁缺毋滥**）；三条必须来自不同信源、不同主题、不同事件；**T3 社区信源永不单独成条**，必须有第二个信源印证。

### 一个诚实的定位

这套标准**不是「真理判定器」，是「证据强度排序器」**。它把「谁说的、几个来源说的、有没有技术增量、原文给没给细节」变成可审计的分数，并把依据印在邮件里。它做不到替你判断某篇论文的方法是否成立、某笔融资是否合理 —— 那个判断权留给你。

---

## 可靠性设计

| 风险 | 处理 |
|---|---|
| 电脑在推送时刻睡眠/关机 | 四个触发器：08:00 定时 + 每 30 分钟轮询 + 登录 + 解锁，配合 `--if-due` 幂等闸门 |
| 重复投递 | `--if-due` 读 `state.json` 的 `last_sent_date`，当天发过就退出 0 |
| 半夜开机被提前推送 | `--if-due` 还有第二道守卫：早于 `schedule.time` 一律不发 |
| 单个信源抓取失败 | 失败信源在其余信源跑完后统一重试一次；仍失败就如实写进邮件告警条 |
| arXiv / 站点限流 | 读 `Retry-After`，指数退避；403/404/410 直接放弃（重试没意义） |
| 模型把段标题写进正文 | `_strip_label` 循环剥离 |
| 模型把解读写太长 | 三层控制：字段子预算 → 外科手术式重写（只改超标字段）→ 仍超标则按句子边界程序化裁剪 |
| 模型幻觉来源 | 可信度徽章由程序算；无摘要条目降权且不得进精选 |
| 状态文件损坏 | 读失败就从空状态开始（最坏是多发一条，不是不发） |
| 服务器不接受中文发件人 | `From` 显示名做 RFC 2047 编码 |

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `--status` 列出「未配置…」 | 凭据文件路径或键名不对，对照上一节 |
| `SMTP 登录成功` 但收不到信 | 看垃圾箱；把发件人加白名单 |
| `Google DeepMind ... fetch failed` | 该域名在部分网络下间歇性不可达，不是代码问题。重试机制会自动再试一次 |
| 邮件里出现「⚠️ 部分信源本次不可达」 | 同上，属设计内的如实披露 |
| 选出来的三条看着不重要 | 调低 `digest.min_importance` 或放宽 `window_hours`；也可以跑 `--preview` 看完整候选池 |
| `--preview` 每次都换内容 | LLM 采样非确定，同一份代码多跑几次结果会变。以「是否落在设计容差内」验收 |
| 想重发同一批内容 | `--ignore-seen` |
| 面板里改了配置不生效 | 配置写在 `<userData>\dsh-auto-email\config.json`，DSH 里改完点保存会立刻重新解析 |

---

## 开发

```powershell
node test/all.mjs             # 全部离线套件，一条命令；142 项检查
node test/all.mjs --live      # 额外联网实测 10 个信源的条数与样例

# 也可以单独跑
node test/render.mjs      # 离线：两个渲染器、HTML 转义、空链接（19 项）
node test/plugin.mjs      # 离线：配置分层、时区算术、MIME 组装、幂等闸门、迁移合并、在跑时不重复触发（32 项）
node test/digest.mjs      # 离线：聚类、打分、精选、字数控制（39 项；本地 http stub，不花 API 额度）
node test/feeds.mjs       # 离线：RSS 2.0 / RSS 1.0-RDF / Atom 的边角（19 项）
node test/http.mjs        # 离线：429 Retry-After、确定性失败不重试（15 项）
node test/host-half.mjs   # 离线：用桩包加载 host 半边，验证 4 工具 / 8 路由的注册形状（18 项）
node test/sources-live.mjs # 联网：10 个信源逐个实测（会写 test/sources-live.out.txt）
```

这些套件全部离线，**不会花 API 额度、不会发信**：LLM 与 SMTP 都打到本地 stub。
`test/digest.mjs` 还会读 `test/difflib-parity.json`，把 JS 的 `sim()` 与 Python
`difflib.SequenceMatcher` 的 15 组比值比对到 6 位小数 —— 聚类阈值是从 Python 版调出来的，
两边算不出同一个数，阈值就失去意义。

**零依赖**是硬约束：只用 `node:` 内置模块和全局 `fetch`。不要为了省几十行引入包 —— 插件要在别人的机器上 clone 下来就能跑。

移植契约与两套实现的对齐关系见 [`docs/PORT-CONTRACT.md`](docs/PORT-CONTRACT.md)。

### 写 DSH 插件时踩过的坑（实测，非推测）

这些错误都只在**运行中的 DSH 里**才会现形，`node --check` 与离线单测原本看不见；现在
`test/host-half.mjs` 用桩包复刻了它们，改坏了会在本地立刻失败。

| 坑 | 症状 | 正确做法 |
|---|---|---|
| 对象型工具参数缺 `additionalProperties` | 插件整块加载失败：`JsonSchemaError: unsupported JSON schema: parameters.set.additionalProperties must be explicitly true or false`；`/status` 返回 401（路由根本没注册） | `defineTool` 的 `parameters` 里任何 `type: 'object'` 的节点都要显式写 `additionalProperties: true/false` |
| 启动器 id 与 `?rev=` 没一起换 | 改了 `lib/` 却像没生效：dsh-hmr 对同一 row 复用已导入的模块 | 用 `node scripts/install.mjs --mount --rev N` 同时改 row id 与模块 URL，两者都新才会重新导入 |
| browser 半边没注册槽位就渲染 | 控制台报 `slot "sidebar.footer.action" is not declared` —— 该槽位由内置侧边栏在 React 渲染期间声明，比插件加载更晚 | 用 `ctx.slots.inject(key, factory)`，而不是裸调 `ctx.slots.register()` |
| 槽位注册值不是 React 组件 | 面板位置渲染不出任何东西（渲染器以 `jsx(Comp, {...kit})` 挂载） | 注册一个组件，不要注册脱离的 DOM 元素 |
| 改动 client.js 后不刷新 | 面板还是旧的 | browser 半边的热更新需要 `pnpm run dev:web`；没有它时刷新一次浏览器页面 |
| `.ps1` 用中文注释且不带 BOM | Windows PowerShell 5.1 按系统 ANSI 代码页解码，报假的 `Missing closing '}'` | 脚本保持纯 ASCII；必须用中文时让文件带 UTF-8 BOM |
| `.bat` 里写中文注释 | cmd.exe 在 `chcp 65001` 生效前就按旧代码页解析，报 `'M' is not recognized as an internal or external command` | 批处理保持纯 ASCII |

> 查证入口：`%APPDATA%\dsh-desktop\logs\harness.log`。插件加载失败会在这里写
> `error dsh-auto-email: ...` 和 `warn hmr: Error: dsh: warning: 1 entry did not activate`；
> 加载成功会写 `auto-email: ready; at=08:00 tz=Asia/Shanghai ...`。

### 目录结构

```
lib/
  index.js     入口 shim（?rev= 缓存破坏）
  plugin.js    host 半边：4 个工具 + 8 条路由
  client.js    browser 半边：侧边栏面板
  config.js    配置分层、校验、路径解析
  service.js   调度、幂等闸门、状态持久化
  pipeline.js  六步编排
  sources.js   10 个信源 + RSS/Atom/RDF 自写解析器
  digest.js    聚类、双级打分、精选、字数控制、LLM 调用
  render.js    纯文本 + 内联样式 HTML 渲染
  mail.js      自写 SMTP 客户端（465 隐式 TLS / 587 STARTTLS）
  state.js     状态库（仅存标题哈希）
  item.js      流水线行记录
```

---

## 许可

[MIT](LICENSE)
