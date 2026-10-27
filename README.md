<div align="center">

# OpenCode Zen FreeX

在 [magpie](https://github.com/yetone/magpie) 里用 **OpenCode Zen 的免费模型**

共享凭据 `public` 即用 · 自动发现 · 原生流式协议

**简体中文** · [English](https://github.com/tkhs101/OpenCode-Zen-FreeX/blob/main/README.en.md)

[![CI](https://img.shields.io/github/actions/workflow/status/tkhs101/OpenCode-Zen-FreeX/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tkhs101/OpenCode-Zen-FreeX/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/opencode-zen-freex?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-zen-freex) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE) [![Runtime: bun](https://img.shields.io/badge/runtime-bun-f472b6?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)

</div>

## 为什么有这个分支

 [zen-free](https://github.com/magpie-community/plugins/tree/main/packages/zen-free) 是这个插件的前身。先说清楚：上游一直在维护，修 Bug 也很快。问题在于它对**免费模型支持**这件事，始终缺少一个**稳定、明确的态度**

免费模型失效时，用户反馈issue，得到的答复却是**将不再支持**；过一段时间，相关问题又被悄悄修复，免费模型重新恢复可用。支持、放弃、再支持——用户只能跟着上游的态度**反复折腾**，却始终无法确定这份支持究竟能持续多久

既然有人依赖它，就值得一个明确的答案，而不是**反复摇摆**，这就是本项目诞生的原因
| UTC | 提交 | 上游说了什么 |
| --- | --- | --- |
| 2026-10-13 23:53 | [`643ef50`](https://github.com/magpie-community/plugins/commit/643ef5018e63be78c4aa7554696831d4220ac9c9) | README 加上说明：免费层「只在 OpenCode 本体里能用」，`this plugin doesn't work around that`，请改用 Zen 付费 key 或 OpenCode Go；提交说明里写着 `No version bump … The code on main is left as it is` |
| 2026-10-14 10:57 | [`a810ee7`](https://github.com/magpie-community/plugins/commit/a810ee7e882012ab106e2deb742176cd43db781a) | 0.1.6 把那段说明**删掉**，改为发 OpenCode 1.19.0 原样的请求头——距加上去 11 小时 |
| 2026-10-14 17:59 | [`5fc0a75`](https://github.com/magpie-community/plugins/commit/5fc0a75292f0e5c0c10cf65a188bff5545d6b8e9) | 0.1.7：`free models answer again` |

上游的后续更新会按需合并，同时保留自己的取舍（比如系统提示词与完整工具集合按代从真实 OpenCode 采集，而不是钉死某一个版本）

## 安装与登录

```sh
magpie plugin add opencode-zen-freex
magpie plugin login opencode-zen-free
```

密钥填 `public`。这是 Zen 免费层的共享凭据，不需要个人 API key——填别的也会被丢掉。

个人 key 请加到 magpie 内置的 OpenCode Zen provider，那里支持多把 key 的切换与故障转移。凭据保存在 OpenCode 的 `auth.json` 或 magpie 的 `plugin-auth.json`。

## 模型

模型名写作 `opencode-zen-free/<id>`，例如 `opencode-zen-free/big-pickle`。

- **自动发现**：宿主列举模型时读取 Zen 的列表，60 秒内的重复列举复用上一次结果。读到的列表会写进缓存（`~/.cache/opencode-zen-freex/discovery.json`，Windows 在 `%LOCALAPPDATA%` 下）；列表读不到时由缓存或包内旧表顶替，有缓存时把数据的年龄一并告知宿主。
- **上限按实测**：目录、厂商自述与路由实际执行的墙常有出入。上下文按实测能过的最大值对齐，输出优先取同一网关付费孪生的声明。例如 `mimo-v2.6-flash-free` 目录写 20 万，实测 37.5 万；`glm-5.3-flash-free` 的付费孪生声明 100 万，实测 32.3 万；路由自己否掉的上限也照认，`deepseek-v4.1-flash-free` 的 100 万因此收紧到 32.6 万。依据与复测方法见 [`MAINTAINING.md` 的 “Limits Zen under-reports”](MAINTAINING.md#limits-zen-under-reports)。
- **上限还会从流量里学**：插件不额外发请求，只用自己转发的请求向上试探、向下收敛；学到的值重启后仍在，被拒的模型会自动收回到已经证明能过的尺寸。
- **实测快照不用等发版**：仓库每小时做一次增量实测，写入 `limits-observed.json` 并发布到 `main`；插件启动后每小时最多后台拉取一次，读不到就用缓存或包内副本。
- **列表说了算**：Zen 列表里的 `-free` 模型立即提供（本插件不支持的协议除外），不等目录补齐；目录读不到只影响它描述的那部分，不代表列表是回退结果。
- **不再免费即 404**：错误会列出当时可用的免费模型；模型重新免费后，刷新列表即可。可用性与限流归 Zen 管，插件看不到剩余额度。

## 请求

请求发往 `https://opencode.ai/inference/v1`，按每个模型的原生协议走（Chat Completions / Responses / Anthropic Messages），流式与普通 JSON 都支持。

- **只借 OpenCode 的外壳**：请求头、User-Agent、系统提示词与完整工具集合配套为现行的 2.x 一代 OpenCode（1.x 通道已于 2026-10-25 被免费层退役；被退役的通道不是改措辞能救的）。官方提示词放在宿主自己的系统指令之前；正文里已经带着它就不再动，重复整形不会注入两遍。提示词到环境块为止，不点名任何内建 skill——宿主没有 OpenCode 的内建 skill 可加载。请求还必须**从 Bun 运行时发出**，与官方客户端一致：magpie 用自带的 Bun 跑插件，本插件正是借此通过。请求头是刻意挑出的最小集合——**不要自行添加**，两个各自无害的头组合起来也会被拒。
- **宿主的工具照常运行**：每个工具保留自己的措辞与参数，但以 `clint_` 前缀的名字上路，不会与随后附上的官方工具集合相撞。请求里对它的每一处引用一并改名，回复里的名字再翻译回宿主声明的原名；宿主不会见到自己没声明的名字。OpenCode 自家的工具以采集到的完整形态发送——并且由于官方提示词教的是 Code Mode，提示词后会追加一段 `<system-reminder>`，点名本宿主真正可调的 `clint_` 工具，模型不会开局就调 `execute` 撞上 unknown tool。
- **工具名对不上就原样交给宿主**：先精确匹配，再忽略大小写，最后忽略 `_`/`-`/`.`/空白，只取唯一结果；对不上或有歧义时不猜、不丢，由宿主回自己的「没有这个工具」，模型据此改名重试。只有没有名字的调用会被略去，并在正文说明。
- **每个请求自成会话**：每个请求都新铸一枚 OpenCode 形状的会话 id——时间戳取当前时刻，永远落在上游接受的窗口内。Zen 把它对流量的记忆记在会话上，新会话不带旧账。设 `OPENCODE_ZEN_FREE_SESSION_AFFINITY=1` 可回到按会话保持（宿主给的 OpenCode 形状 id 原样传，否则从宿主的会话标识派生并记住，同一会话各轮共用一个 id）。
- **项目 id 也是自己的**：`public` 是全世界共用的凭据、区分不了任何人，所以限额与 key 无关，只能按能区分流量的维度记账——出口 IP 一本总账，其下「项目 id × 出口」各一本小账。出口有余量时，换一枚 id 就是一本新账（2026-10-26 实测）；热门出口的 IP 总账被同一条出口上的全球流量常年烧穿，那时换多少 id 都是同一句 429（2026-10-27 实测：某刚通过准入探测的美国节点，5 千与 3 万 token 的请求连试 10 枚全新 id 全 429——而在探测通过与首次被拒之间的几分钟里，我们自己在该 IP 上只花了约 1 万 token，烧穿它的是同 IP 的世界流量）。宿主给了项目 id 就用它的；没给则每请求随机生成一枚 git-hash 形状的专属 id——旧默认 `global` 是全世界蹭免费插件共享的桶，热门出口上早已被烧光。
- **429 会换一本账再问一次**：宿主遇到 429 会结束整轮并报告额度耗尽，所以插件在把它交出去之前，换一枚没花过的项目 id 与会话 id、把同样的字节再发一次——出口有余量时这就是一本新账；出口总账烧穿时这不是改 id 能救的（只有换出口或等回填），重试只是替宿主确认过。默认重试 2 次，首次等 1.2 秒、逐次翻倍（`OPENCODE_ZEN_FREE_RETRY_429=0` 关闭，`OPENCODE_ZEN_FREE_RETRY_WAIT_MS` 与 `OPENCODE_ZEN_FREE_RETRY_WAIT_MAX_MS` 调等待与封顶，都在下一个请求就生效）。默认值刻意偏短：多数宿主身后没有值得等待的东西，总账烧穿后再等只是把同一句拒绝延后。**出口会轮换的部署**（同一请求在出口变了之后能成功）可以把首次等待与封顶一起抬到盖过轮换耗时——但先确认两件事：轮换真的会被 429 触发（magpie 把流式请求的 429 包成 HTTP 200 发给客户端，只看代理状态码的钩子一条也看不见），且换完后真实流量真的走新出口（代理切换不迁移 keep-alive 长连接，不掐断的话请求还钉在旧出口上）（均 2026-10-27 实测）。只重试 429：403 是指纹或出口、426 是版本、5xx 是端点故障，换 id 都救不了；正文点名出口滥用的 429 也不重试，因为没有哪个 id 能救一个被封的出口。宿主自己命名的项目 id 每次都用它——那是宿主对自己的陈述，不该为了绕开限流而改写。重试用尽后交出去的，仍是 Zen 自己那条 429，原样未改。
- **截断与错误如实报告**：流提前结束时，Chat 流若有内容且无未完成调用，按截断回答收尾并注明；其余情况一律失败。错误正文只读一小段找 Zen 自陈的上限，其余替换为说明。

<details>
<summary>请求头与会话 id 的完整规则</summary>

**请求头**只有这些：`content-type`、`accept`、`user-agent`、`x-opencode-project`、`x-opencode-session` 与 `x-opencode-session-id`（同一个值）、`x-opencode-client: cli`、`authorization: Bearer public`；走 Messages 时改用 `x-api-key: public` 加 `anthropic-version`。`anthropic-beta` 插件自己从不设置，宿主发了才原样透传。

**会话 id**：默认每请求新铸一枚，下面这些信号一概不读。设了 `OPENCODE_ZEN_FREE_SESSION_AFFINITY=1` 时，按顺序取：会话头 `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` / `session_id` / `conversation-id` / `conversation_id`，body 的 `conversation_id`，`metadata.session_id`，或 Claude Code 的 `metadata.user_id` 里的 `_session_<uuid>`。都没有时用 system/instructions 与首条用户消息做种子（system 变了就是另一个会话）；再没有才看 `previous_response_id`，仍然没有则每次新生成。空字符串一律不算名字。

</details>

## 免费层不再应答时

插件给出的 403 会写明提示词与工具定义采集自哪个 OpenCode 版本，先从它查起。下面三条都**只在仓库副本里**可跑（`check:gate` 与 `capture` 不在发布包里），需要 Bun；`capture` 还需要 PATH 里有 `opencode`：

```sh
bun run check:gate          # 问 Zen 还认哪代指纹；只要有一代 floor 被应答，退出码为 0
bun run capture -- --dry    # floor 全被拒时：取新采集并报告差异，不写入
bun run capture             # 确认差异后才写入
```

`fingerprint.json` 缺失或损坏时，`capture` 会重写一份而不是拒绝。它不写提示词与完整工具集合：那两样在 `opencode-prompt-v1.txt` 与 `official-tools.json` 里，发版时随同一代 OpenCode 的采集一起更新（见 [`MAINTAINING.md`](MAINTAINING.md#the-loop)）。闸门并不稳定：结论只代表此刻，信之前再跑一遍；同一地址反复被拒后还可能进冷却期。逐代结论与失败判读见 [`MAINTAINING.md` 的 “The loop”](MAINTAINING.md#the-loop) 与 [“Reading a failure”](MAINTAINING.md#reading-a-failure)。

## 排查

| 现象 | 处理 |
| --- | --- |
| 每个请求都是 `403 FreeTierError`，正文没有出口封禁文案 | 采集的 OpenCode 形态过期。升级插件；在仓库副本里跑 `bun run check:gate`，全被拒时重新采集指纹，并从同一发行版刷新提示词与工具资产 |
| `403` 正文是封禁文案（`abuse of traffic`，或 `free models aren't available … from your current network`） | 免费层封的是当前出口。等封禁解除；重试与改请求都无用 |
| `426 Upgrade Required` | 这个包自称的 OpenCode 版本比 Zen 要的旧。升级插件，或在更新的 OpenCode 里运行 |
| `429`，且宿主因此结束整轮、报「额度已用尽」 | 先确认重试没被关掉（`OPENCODE_ZEN_FREE_RETRY_429` 不能是 `0`）。插件已换新账本重试过仍被拒，说明这个出口的总账已烧穿：等回填，或换出口（轮换部署确认轮换真的被触发、且换完后连接真的换路，见上面「429 会换一本账再问一次」）。若正文是出口封禁文案，见上面 `403` 那行 — 出口被封时插件按设计不重试 |
| `404 … not available as an OpenCode Zen free model now` | 该模型已不再免费。从报错列出的模型里换一个 |
| `Model is not an available free model for this protocol` | 请求发出时列表变了。让宿主刷新模型列表再试 |
| `uses the public credential` | 存的密钥不是 `public`。用 `public` 重新登录 |
| 不带 `FreeTierError` 的 `403` | 是 Zen 自己的 403，与本插件无关；按原文处理 |
| `400 context_length_exceeded`，或 `max_tokens` 超出范围 | 路由按模型自己的上限校验。压缩对话或调小 `max_tokens`；上下文拒绝不报窗口数字，`max_tokens` 拒绝会给出允许范围 |
| 窗口偏小想重学，或新设的环境变量没生效 | 删掉缓存目录下的 `opencode-zen-freex/limits.json`（目录规则见[环境变量](#环境变量)）；环境变量只在宿主启动时读，改完要重启 |
| 模型被问错了协议 | 协议文档的端点表没读出来。设 `OPENCODE_ZEN_FREE_MODELS_DEBUG=1` 看是哪份文档、为什么没读出来 |
| 想确认快照是否新鲜、模型是否下线 | 在仓库副本里跑 `bun limits-watch.mjs --status`；退出码 0 正常、2 已读但有问题、1 读不到。`unavailable` 只是历史，不是停用开关 |
| 窗口停在旧值，或连不上 `raw.githubusercontent.com` | 远程快照只是优化，失败不影响请求。用环境变量换源或关闭（见[环境变量](#环境变量)） |

## 环境变量

最常用的几个；完整清单与默认值见 [`.env.example`](https://github.com/tkhs101/OpenCode-Zen-FreeX/blob/main/.env.example)。缓存目录在 Windows 上是 `%LOCALAPPDATA%`，其余平台是 `$XDG_CACHE_HOME` 或 `~/.cache`。

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_ZEN_FREE_DISCOVERY_CACHE` | 模型发现缓存路径；空字符串表示只在内存中 |
| `OPENCODE_ZEN_FREE_SESSION_AFFINITY` | `1` 恢复按会话保持，不再每请求新铸会话 id |
| `OPENCODE_ZEN_FREE_RETRY_429` | 429 的重试次数，默认 `2`；`0` 关闭 |
| `OPENCODE_ZEN_FREE_RETRY_WAIT_MS` | 首次重试前等待的毫秒数，默认 `1200`，逐次翻倍 |
| `OPENCODE_ZEN_FREE_RETRY_WAIT_MAX_MS` | 等待封顶，默认 `5000`；出口会轮换的部署把它调过轮换耗时 |
| `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT` | 实测快照路径；空字符串表示不读快照 |
| `OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL` | 远程快照地址；空字符串关闭远程 |
| `OPENCODE_ZEN_FREE_LIMITS_STATE` | 学习到的上限状态路径；空字符串表示只在内存中 |
| `OPENCODE_ZEN_FREE_LIMITS_DEBUG` | `1` 时把抬高、被拒与路由自报的窗口打到 stderr |
| `OPENCODE_ZEN_FREE_MODELS_DEBUG` | `1` 时打印模型目录的解析细节 |
| `OPENCODE_ZEN_FREE_MAX_WINDOW` | 向上试探的窗口上限，默认 `1048576` |

## 鸣谢

| 类别 | 项目 |
| --- | --- |
| 本插件前身 | [zen-free](https://github.com/magpie-community/plugins/tree/main/packages/zen-free) |
| 插件载体 | [magpie](https://github.com/yetone/magpie) |
| 模型提供者 | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| 本仓库常用 Agent | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [hermes-agent](https://github.com/NousResearch/hermes-agent) |
| 灵感来源 | [9router](https://github.com/decolua/9router) · [opencode2api](https://github.com/jasonxu114514/opencode2api) · [zen-gate](https://github.com/LAGcomcom/zen-gate) |

## 许可

MIT。分叉自 [zen-free](https://github.com/magpie-community/plugins/tree/main/packages/zen-free)，`LICENSE` 正文原样未改：版权行同时保留上游作者 `xiaozhou26` 与本分支的 `OpenCode-Zen-FreeX contributors`。来源与维护缘由见 [NOTICE](NOTICE)。
