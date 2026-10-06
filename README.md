# dsh-trae-connect

将 Trae CN（国内版）桌面 App 的模型接入 DeepSeek Harness。复用桌面 App 的登录状态（自动解密本地凭据），在 DSH 模型选择器中出现「Trae」分组，零配置使用。

仅供个人学习和研究使用；请遵守 Trae 服务条款。协议参照 MIT 许可的 [Trae2api-cn](https://github.com/autumnsentiment/Trae2api-cn) 项目的公开文档实现。

## 功能

- **零配置**：安装并启用插件后重启 DSH，模型选择器出现「Trae」分组（前置：本机安装并登录 Trae CN 桌面 App）。
- **动态模型目录**：模型列表从 Trae 线上实时拉取（`/models?functions=solo_agent_remote&show_custom_model=true`），每 10 分钟自动刷新，新模型上架无需更新插件；拉取失败时回落到内置兜底列表。
- **1M 上下文开关**：设置卡片提供「使用上游声明的最大上下文窗口」开关（默认开）。开启后 max-mode 模型的描述符用 1M 窗口，请求带 `strategy:"max"` 等 max 会话字段；关闭则用默认 200K。
- **思考强度档位**：模型声明了哪些档位（light / high / extra_high）就在选择器里映射哪些；未声明的模型不提供档位选择。
- **即用即焚**：每轮对话答完自动删掉 Trae 侧的临时远程会话，避免刷爆它的会话列表（默认开，删除失败不影响对话本身）。可在设置卡片关闭。
- **令牌自动续期**：Cloud-IDE-JWT 到期前 30 分钟自动经 `ExchangeToken` 刷新；桌面 App 重新登录或轮换令牌时自动跟随。

## 工作原理

1. **凭据**：读取 `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide`，用「tc」信封算法（AES-128-CBC + SHA-512 派生密钥，盐为 App 内置静态常量）解密出 Cloud-IDE-JWT 与 refreshToken。插件副本存于 `<DSH_HOME>\.trae-connect\credentials.json`（0600）。
2. **小门**：本机 127.0.0.1 随机端口起一个 OpenAI 兼容 HTTP 服务（`/v1/models`、`/v1/chat/completions`），带逐进程 Bearer 令牌与 Host/Origin 回环校验。
3. **翻译**：把 OpenAI 请求翻译成 Trae remote 会话协议（`POST /api/remote/v1/chat_sessions` + SSE 事件流），`Authorization: Cloud-IDE-JWT …`，Origin `solo.trae.cn`。快照流只接受严格更长且前缀延伸的帧，防止上游重发的旧快照造成内容重复。
4. **注册**：经 `ctx.llm.registerAdapter` 注册 `trae` provider（PiAiAdapter），模型目录指向小门。

## 已知限制

- 仅支持国内版（CN）；国际版凭据与接口不同，未覆盖。
- 工具调用（function calling）未实现：Trae remote 协议的工具桥接复杂，只支持文本/推理对话。
- 依赖 Trae 客户端私有接口，Trae 更新后可能需要调整。

## 免责声明

- 本项目仅供个人学习和研究使用，仅驱动使用者自己的 Trae 账号在本机调用，请勿用于商业用途。
- 因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目与 Trae、字节跳动、DeepSeek 均无关联，未获其授权或认可。

## 许可证

[MIT](./LICENSE)
