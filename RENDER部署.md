# Render 部署配置

先将项目上传到自己的 GitHub 私有仓库。请使用本次提供的部署包，里面不含 `.env`、虚拟环境或测试音频。

在 Render 选择 New → Web Service，连接这个仓库。授权 GitHub 时选择 Only select repositories，仅勾选此仓库。

| 字段 | 填写内容 |
| --- | --- |
| Name | zhishengji-voice |
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
