# dsh-trae-connect

将 Trae 桌面 App（国内版 / 国际版）的模型接入 DeepSeek Harness。自动发现本机 Trae 数据目录，复用桌面 App 的登录状态（自动解密本地凭据），在 DSH 模型选择器中出现「Trae」（Trae 国内版）与「Trae Intl」（Trae 国际版）分组，零配置使用。

仅供个人学习和研究使用；请遵守 Trae 服务条款。协议参照 MIT 许可的 [Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) 项目的公开文档实现。

## 功能

- **自动发现数据目录**：启动时扫描 `%APPDATA%` 下所有 `Trae*` 目录（`Trae CN`、`Trae`、`TRAE SOLO`、`TRAE SOLO CN` 等），对每个候选逐一尝试读取并解密 `User\globalStorage\storage.json`，谁能解出有效令牌用谁。国内版 / 国际版各自取第一个成功者，装了哪个版本就出哪个分组，两个都装则两组都出。换电脑、换版本不再需要改代码。
  - **显式路径优先**：设置卡可分别填写国内版 / 国际版的数据目录（或 storage.json 全路径）强制指定；也可用环境变量 `TRAE_DATA_DIR_CN` / `TRAE_DATA_DIR_INTL`。显式路径永远优先于自动扫描。
  - **排错提示**：扫描后一个凭据都解不出来时，日志会提示——**请确认 Trae 桌面程序已启动并登录过（扫描模型列表与路径期间需保持程序处于启动状态）；首次使用请先在 Trae 里完成一次登录**。
- **动态模型目录**：模型列表从 Trae 线上实时拉取（`/models?functions=<按版本选桶>&show_custom_model=true`），每 10 分钟自动刷新，新模型上架无需更新插件；拉取失败时回落到内置兜底列表。国内版与国际版目录各自独立拉取、互不混淆。拉取桶：国内版 `solo_agent_remote`（16 个全可用）；国际版 `solo_agent`（**全量目录**，与 Trae 国际版界面显示一致，实测 2026-10-08 为 19 个）。
- **积分倍率显示**：模型名后标注上游声明的积分消耗倍率（` · x0.8`）。倍率字段双版兼容：国内版来自 features 里的 `consumption_rate.data.rate`，国际版（实测）来自 `cost.data.manual_usage`（1 = 原价）；个别实验模型未声明则不标。用户在 Trae 里自配的自定义模型（走用户自己的 API 链接，is_preset=false / 带 custom_model_id / config_source=3）不会出现在选择器中。
- **锁定模型标注（国际版）**：国际版列出的是账号档位的**全量目录**——当前档位可用的正常显示（带倍率标），付费档模型标 `· 🔒 未解锁`（不标倍率）。锁定与否由每次目录刷新时按上游最新数据重算（模型 features JSON 的 `access.data.identity_list`：**含 5 且不含 0 判为锁定**——判据为实测归纳：2026-10-08 零积分探针 11/11 吻合，含 `[0,5,4,1,2,3]` 可用与 `[5,4,1,2,3]` 锁定的同形对照；上游正式判据未确认），不缓存、不写死名单；用户升级 Trae 付费档后，identity_list 变化，锁定标在下一轮刷新自动消失。选中锁定模型时上游会拒绝建会话（"not available for this account"），插件报错会注明「该模型需升级 Trae 付费档后使用」。
- **1M 上下文开关**：设置卡片提供「使用上游声明的最大上下文窗口」开关（默认开）。开启后 max-mode 模型的描述符用 1M 窗口，请求带 `strategy:"max"` 等 max 会话字段；关闭则用默认 200K。
- **思考强度档位**：模型声明了哪些档位（light / high / extra_high）就在选择器里映射哪些；未声明的模型不提供档位选择。
- **即用即焚**：每轮对话答完自动删掉 Trae 侧的临时远程会话，避免刷爆它的会话列表（默认开，删除失败不影响对话本身）。可在设置卡片关闭。
- **令牌自动续期**：Cloud-IDE-JWT 到期前 30 分钟自动经 `ExchangeToken` 刷新；桌面 App 重新登录或轮换令牌时自动跟随。

## 国内版 vs 国际版

| 分组 | provider id | 数据目录（自动扫描） | 凭据格式 | 上游 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Trae（Trae 国内版） | `trae` | `%APPDATA%\Trae CN\User\globalStorage\storage.json` | tc 加密 | `https://trae-api-cn.mchost.guru/api/remote/v1`（实测可用） | ✅ 完整支持 |
| Trae Intl（Trae 国际版） | `trae-intl` | `%APPDATA%\Trae\User\globalStorage\storage.json`（同为 tc 加密信封，与国内版同一套解密算法） | tc | `https://core-normal.trae.ai/api/remote/v1`（实测 200） | ✅ 已实测（2026-10-08，真凭据验证） |

**国际版实测结论（2026-10-08，本机真凭据验证）**：

- **域名**：remote 门为 `https://core-normal.trae.ai/api/remote/v1`，来自国际版程序自带 `product.json` 的 `remote.trae` 段（SG/US 镜像 `coresg-normal.trae.ai` 同路径同效果）。凭据记录自带 host（`growsg-normal.trae.ai`）是**鉴权域**，不是 remote 门，插件不会拿它当上游。设置卡「国际版上游地址」仍可覆盖默认值（显式优先）。
- **双头鉴权**：必须同时发 `Cloud-IDE-JWT: <token>` 与 `Authorization: Cloud-IDE-JWT <token>` 两个头——实测只带其一均返回 401。国内版保持单头不变。
- **回包结构**：国内版回 `{data:[…]}`（数组即模型列表）；国际版回 `{code:0, data:{list:[{function:"solo_agent", models:[…]}]}}`——模型数组在 `data.list[].models` 里，解析器两种形态都认，按版本选桶：国内版取 `solo_agent_remote` 条目，国际版取 `solo_agent` 条目（全量档位视图，含未解锁模型）。
- **模型字段**：与国内版基本同名（`name/display_name/is_preset/max_mode/context_window_tokens/features`）。倍率在 features 的 `cost.data.manual_usage`（数值，1 = 原价）；上下文窗口读 `context_window_tokens.dev`，实测部分模型 `max=0`（无 max 档），此时沿用 dev 值、不出 0。
- **实测名单**（2026-10-08，`solo_agent` 全量桶 20 条目 = auto + 19 模型；✅=本账号可用，🔒=需升级付费档）：✅ auto、gemini-3.1-pro、gemini-3-flash-solo、minimax-m3、minimax-m2.7、kimi-k3、kimi-k2.5、kimi-k2.7-code、deepseek-v4-flash-0731、Dola-Seed-2.0-Code、gpt-6-sol、gpt-6-luna、gpt-5.4、gpt-5.2（14 个可用，探针零积分复测 kimi-k2.7-code / deepseek-v4-flash-0731 / Dola-Seed-2.0-Code 均可建会话）；🔒 gpt-6-astra、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-5.5、glm-5.2（6 个）。锁定状态随每次目录刷新自动重算，升级后自动解锁显示。
- **令牌续期**：ExchangeToken 走凭据记录自带的鉴权域 host（路径与 ClientID 同国内版）——官方 trae2api PROTOCOL.md 同此记录；设置卡的「国际版上游地址」仅在凭据无 host 时作为兜底。
- 仍留作可填项的只有「国际版积分接口根地址」（官方积分域名未实测，留空则状态卡不查积分）。

## 工作原理

1. **凭据**：扫描 `%APPDATA%\Trae*` 目录，读取各候选 `User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide`，用「tc」信封算法（AES-128-CBC + SHA-512 派生密钥，盐为 App 内置静态常量）解密出 Cloud-IDE-JWT 与 refreshToken（国际版若存的是明文 JSON 则直接解析）。凭据按目录名与记录内 host/region 归入国内版或国际版。插件副本存于 `<DSH_HOME>\.trae-connect\credentials.json`（国内版）与 `credentials-intl.json`（国际版），权限 0600。
2. **小门**：本机 127.0.0.1 随机端口起一个 OpenAI 兼容 HTTP 服务（`/v1/models`、`/v1/chat/completions`），带逐进程 Bearer 令牌（国内版与国际版各持一枚，防止两侧模型目录重名时串线）与 Host/Origin 回环校验。
3. **翻译**：把 OpenAI 请求翻译成 Trae remote 会话协议（`POST /api/remote/v1/chat_sessions` + SSE 事件流）。国内版 `Authorization: Cloud-IDE-JWT …`、Origin `solo.trae.cn`；国际版（实测）双头同带（`Cloud-IDE-JWT` + `Authorization: Cloud-IDE-JWT`）、Origin `work.trae.ai`。快照流只接受严格更长且前缀延伸的帧，防止上游重发的旧快照造成内容重复。
4. **注册**：经 `ctx.llm.registerAdapter` 注册 `trae` 与 `trae-intl` 两个 provider（PiAiAdapter），模型目录指向同一个小门，按 Bearer 令牌区分版本。

## 已知限制

- 国际版积分接口域名未实测：对话与模型目录已实测可用（见上表），但状态卡积分查询需自行填入「国际版积分接口根地址」才启用。
- 工具调用（function calling）未实现：Trae remote 协议的工具桥接复杂，只支持文本/推理对话。
- 依赖 Trae 客户端私有接口，Trae 更新后可能需要调整。

## 免责声明

- 本项目仅供个人学习和研究使用，仅驱动使用者自己的 Trae 账号在本机调用，请勿用于商业用途。
- 因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目与 Trae、字节跳动、DeepSeek 均无关联，未获其授权或认可。

## 许可证

[MIT](./LICENSE)
