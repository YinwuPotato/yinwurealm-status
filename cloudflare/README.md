# Cloudflare 定时调度

维护：Soidraw。

Worker 每分钟按时间表选择任务，通过 GitHub API 启动 Upptime 原生工作流。实际检测、故障管理、数据保存和网页发布由 GitHub Actions 完成。无需在官网服务器安装插件或脚本。

## 部署

1. 在 Cloudflare 的 Workers & Pages 创建 Worker，名称为 `yinwurealm-upptime-scheduler`。
2. 在 Edit code 中粘贴 [worker.mjs](worker.mjs) 全部内容，点击 Deploy。仓库 `YinwuPotato/yinwurealm-status` 和分支 `master` 已写在代码中。
3. 进入 Settings → Variables and Secrets，添加 Secret：名称 `GITHUB_DISPATCH_TOKEN`，值为 GitHub fine-grained PAT。该令牌仅授权此仓库，权限仅需 Actions 的 Read and write；自动附带的 Metadata 读取权限保留。
4. 保存并部署 Secret，在 Settings → Trigger Events 中添加一条 Cron：

```cron
* * * * *
```

这条规则每分钟唤醒 Worker，实际官网检测每五分钟一次。其他空闲分钟直接返回；无需为每种任务单独添加 Cron。

无需绑定自定义域名。公开 HTTP 请求只返回 404，不会启动任务。`wrangler.jsonc` 供 CLI 部署使用，控制台只需粘贴 `worker.mjs`。

## 时间表

| 任务 | UTC | 北京时间 |
| --- | --- | --- |
| Uptime CI | 每小时第 3、8、13……58 分钟 | 相同分钟 |
| Response Time CI | 00:17、06:17、12:17、18:17 | 08:17、14:17、20:17、次日 02:17 |
| Summary CI | 每天 00:25 | 每天 08:25 |
| Graphs CI | 每天 00:35 | 每天 08:35 |
| Static Site CI | 每天 00:45 | 每天 08:45 |
| Update Template CI | 周一 03:15 | 周一 11:15 |
| Updates CI | 每天 03:30 | 每天 11:30 |

以上为计划触发时间，GitHub 接收请求后可能排队。新增或修改 Cloudflare Cron 通常需要几分钟传播，官方说明最长可能约 15 分钟。

## 验证与排错

在 Worker 的 Observability / Logs 查看调用。检测分钟应出现 `dispatch_accepted` 与 `uptime.yml`，随后 GitHub 对应工作流应执行成功。API 发起的任务显示为 `workflow_dispatch`，不会显示成 `schedule`。

每次部署或更换令牌后，核对至少三轮自动检测及其间隔。`dispatch_accepted` 只代表请求已被接受，仍需检查 GitHub 中的具体执行结果。每日和每周任务分别核对。

| 日志 | 检查位置 |
| --- | --- |
| `Missing Cloudflare Secret` | Secret 名称和部署状态 |
| `request setup failed` | 请求参数或运行环境；括号内为异常类型 |
| `redirect refused` | GitHub 返回了 3xx，代码不会跟随重定向 |
| HTTP 401 | 令牌是否过期、被撤销或填错 |
| HTTP 403 | Actions 权限、组织审批、令牌政策或限流 |
| HTTP 404 | 仓库授权、工作流文件名、默认分支，以及工作流是否已停用 |
| HTTP 429 / 5xx | GitHub 限流或服务状态 |
| `request failed` / `timed out` | 先检查 GitHub 是否已经创建任务，再决定是否补跑 |

代码不会自动重试不确定是否已被接受的 POST，以免重复创建任务。后续五分钟检测会继续；失败的低频维护任务可在 GitHub 手动补跑。日志不输出令牌、原始异常内容或响应正文。

## 日常维护

- 修改代码后运行测试，再将完整 `worker.mjs` 粘贴到 Cloudflare 并部署。
- 调整时间表时修改 `TASKS`；GitHub 备用计划在 `.upptimerc.yml` 中维护。
- 更换令牌时更新 Cloudflare Secret 并部署；确认成功后撤销旧令牌。
- 暂停自动调度可删除 Cron，恢复时重新添加 `* * * * *`。
- GitHub 工作流自身使用的 `GH_PAT` 与 Worker 的令牌分别维护，不混用。

从仓库根目录运行本地测试：

```powershell
node --check cloudflare/worker.mjs
npm.cmd --prefix cloudflare ci --ignore-scripts
npm.cmd --prefix cloudflare test
```

测试涵盖完整一周的计划、错误处理和 workerd 实际运行引擎兼容性。所有请求由本地测试接管，不使用真实令牌或访问 GitHub；不能替代部署后的线上验证。测试依赖只用于本地，不上传到 Worker。

## 参考

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Upptime API 触发](https://upptime.js.org/docs/triggers/#using-the-github-api)
- [GitHub workflow_dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
