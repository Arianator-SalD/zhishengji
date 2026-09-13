# Render 部署配置

## 当前服务名称与网址

Render 后台服务名称为 `careerfly`，服务 ID 仍为 `srv-dain4m3m8hqs73dhvur0`。改名后实际访问网址仍是 [职升机](https://zhishengji-voice.onrender.com)，没有变成 careerfly.onrender.com。若需要新网址，需另建服务或绑定自有域名；新名称可用性尚未确认。render.yaml 的服务名已同步；配置随本轮版本发布，部署状态见最新迭代日志。

## 已有 Sally 服务：增加李彦宏分身

在现有 Render 服务的 Environment 中新增以下两项，不需要创建第二个服务：

```env
ROBIN_TTS_SPEAKER=zh_male_m191_uranus_bigtts
ROBIN_TTS_RESOURCE_ID=seed-tts-2.0
```

`ROBIN_TTS_SPEAKER` 为云舟 2.0 预置男声音色，`ROBIN_TTS_RESOURCE_ID` 为该专家使用的 TTS 模型资源。这两项仅在包含李彦宏接入功能的代码部署后生效，代码也提供相同默认值。它们不是 API Key。

现有 `LLM_API_KEY`、`VOLC_ASR_API_KEY`、`VOLC_TTS_API_KEY` 继续共用；已有旧版 App ID / Access Token 鉴权也可继续使用。保留原来的 `VOLC_TTS_SPEAKER` 和 `VOLC_TTS_RESOURCE_ID`，它们继续控制 Sally。云舟音色需要现有火山账号具有对应 TTS 2.0 资源权限；鉴权错误或音色不匹配时页面会显示服务错误，不会悄悄改用 Sally 音色。

两位专家共用 `/ws/voice`，由 `expert_id=sally` 或 `expert_id=robin-li` 在建立连接时选择，各自拥有独立会话。当前代码中李彦宏默认带入 `content/robin-li/demo_user.json` 的“林小北 · 第一份 AI 产品实习”独立演示档案；Sally 继续使用原金融同学档案。本地界面已移除档案面板与空白模式切换控件，默认档案仍用于咨询上下文，欢迎语不复述用户信息；空白模式保留底层接口。切换专家会关闭旧连接，回到真实专家时开始新会话。人物 Prompt、精选知识和用户档案随仓库 `content/robin-li/` 交付，不依赖外层工作目录。新 case 无需新增环境变量，部署状态见迭代日志；预置经历不是实际咨询历史，本轮新信息尚不写回长期记忆。

验证时先访问有权限的 `/api/config?expert_id=robin-li` 确认对应能力已配置，再在李彦宏页面分别试文字、录音、语音窗口文字播报、打断和切换 Sally。`capabilities` 只表示配置完整，不表示账号余额、权限、网络或实际音质已通过验证。

## 新建服务

将 `zhijian-voice` 当前源码上传到自己的 GitHub 私有仓库，不包含 `.env`、虚拟环境或测试音频。历史部署包不作为本轮源码来源。

在 Render 选择 New → Web Service，连接这个仓库。授权 GitHub 时选择 Only select repositories，仅勾选此仓库。

| 字段 | 填写内容 |
| --- | --- |
| Name | careerfly |
| Language | Python 3 |
| Root Directory | 如果直接上传部署包里的文件到仓库根目录，留空 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn server.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |
| Instance Type | Free（以控制台实际可选项为准） |
| Auto-Deploy | On Commit（推送到关联分支后自动部署） |

Environment 中设置 `PYTHON_VERSION=3.12.12`。再由你亲自在平台中填写下面四项，不要放在仓库文件里。后端自动识别 Render 分配的域名，无需设置通配符允许主机。

| 变量名 | 值 |
| --- | --- |
| `LLM_API_KEY` | DeepSeek 官方 API Key |
| `VOLC_ASR_API_KEY` | 火山语音识别 API Key |
| `VOLC_TTS_API_KEY` | 火山语音合成 API Key |
| `DEMO_ACCESS_PASSWORD` | 自己设置一个至少 12 位的演示口令，只提供给受邀体验者 |

`VOLC_TTS_SPEAKER` 默认是 `zh_female_vv_uranus_bigtts`，如音色不在已开通权限内，请换成控制台音色 ID。

`render.yaml` 也可用于 Blueprint 创建，包含相同配置；不要同时创建两份服务。已有服务需在 Settings 中将 Auto-Deploy 设置为 On Commit，并确认关联分支为 `main`；仅修改仓库文件不会自动更改未由 Blueprint 同步的服务设置。Blueprint 的 Auto Sync 控制部署配置同步，与服务的代码自动部署是独立设置。

访问演示需要先输入口令；口令不会发送给对话模型。口令不足 12 位或未设置时，Render 页面会显示未开放。健康检查仍正常返回，避免部署反复重启。限制每个 IP 每分钟 5 次登录尝试、最多 3 个同时对话连接。GitHub 私有仓库不代表 Render 网页自动私有，所以保留此访问门槛。

免费实例可能休眠，唤醒会延迟；以实际页面展示的套餐限制为准。真正的语音延迟还受部署地区和火山/DeepSeek 接口网络连接影响。

官方参考：https://render.com/docs/deploy-fastapi 、https://render.com/docs/blueprint-spec
