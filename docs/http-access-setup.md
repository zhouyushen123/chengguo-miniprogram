# 电脑端后台：配一条 HTTP 访问路由（约 3 分钟）

> **代码侧已经全好了，只差控制台点一次。**
> `cloudfunctions/admin/index.js` 已经能处理 HTTP 请求（`httpMethod` / `requestContext`）：
> GET 返回 `public/index.html` 登录页，POST 走后台接口，返回带 `statusCode + headers + body` 的标准格式。
> 配完立即生效，**不用重新部署云函数、不用改小程序、不用重新上传体验版**。

> 11-07 复测：`GET https://cloud1-d9gca4e7q307c4564.service.tcloudbase.com/admin`
> 返回 `{"code":"INVALID_PATH"}`。**网关是通的、域名是对的，只是没有 `/admin` 这条路由**——
> 这正是"HTTP 访问服务未配置"的证据，不是环境没开通、也不是函数没部署。

## 一、进到配置页面（两个控制台，哪个能进用哪个）

**A. 腾讯云 CloudBase 控制台（新版，推荐）**

1. 浏览器打开 https://tcb.cloud.tencent.com/dev#/env/http-access
2. 用**小程序管理员的微信扫码**登录腾讯云，选中环境 `cloud1-d9gca4e7q307c4564`
3. 左侧找 **HTTP 网关**（旧界面叫 **HTTP 访问服务**）→ **路由管理** → 点 **新建**

**B. 微信开发者工具内置云开发控制台（旧版）**

顶部 **云开发** → 在环境/设置里找 **HTTP 访问服务** → **添加路由**（有的版本叫「添加路径」）。

> 两代界面按钮名不一样，但**字段名完全一致**：域名、触发路径、关联资源、云函数。
> 认字段、别死记按钮位置；找不到就用 A 那个链接，最稳。

## 二、新建路由要填的四项

| 配置项 | 填什么 | 说明 |
|---|---|---|
| 域名 | **默认域名** | ⚠️ 见第三节，这项最容易选错 |
| 触发路径 | **`/admin`** | 带开头斜杠，不带结尾斜杠；别写成 `admin` 或 `/admin/` |
| 关联资源类型 | **云函数** | 不要选静态托管 / 云托管 |
| 云函数 | **`admin`** | 不是 `admin/` 也不是 `syncv2` |
| 版本 | `$DEFAULT` | 跟随现网，重新部署函数后自动用新代码 |

点确定后**等 3~5 分钟**让网关生效。

## 三、最容易踩的坑：域名选错，小程序给的网址对不上

小程序 **我的 → 电脑端后台** 弹出的网址，是 `cloudfunctions/admin/lib.js` 里 `adminUrl()` 拼出来的：

```
https://cloud1-d9gca4e7q307c4564.service.tcloudbase.com/admin
```

而官方文档里新版 HTTP 网关的默认域名长这样：

```
https://<环境ID>.<地域>.app.tcloudbase.com/admin
```

**两个域名不一样。** 如果控制台只提供 `app.tcloudbase.com`，配完路由虽然能用新地址打开后台，
但**小程序里复制出来的仍是旧地址、会继续报 404**。

所以：

1. 建路由时，域名下拉里如果有 `cloud1-d9gca4e7q307c4564.service.tcloudbase.com`，**优先选它**
2. 如果没有，就把控制台实际给的「默认域名 + /admin」**抄下来告诉我**，
   我改 `lib.js`（或加个 `ADMIN_BASE_URL` 环境变量）+ 重部署一次 `admin`，两边对齐
3. 目前 `adminUrl()` 只支持用环境变量 `ADMIN_ENV` 换环境 ID，**不支持换整段域名**

## 四、怎么确认成功

```bash
curl -s https://cloud1-d9gca4e7q307c4564.service.tcloudbase.com/admin | head -c 120
```

- 返回 `{"code":"INVALID_PATH"}` → 路由还没建好（或路径写错），再等等
- 返回 `<!DOCTYPE html>` 之类 → **成功**，浏览器打开应该看到后台登录页

然后到小程序 **我的 → 电脑端后台**，复制弹窗里的账号和 6 位口令，在浏览器登录。
只有机构负责人/管理员能拿到口令（服务端按 `members` 表判角色）。

## 五、报错对照

| 现象 | 原因 / 怎么办 |
|---|---|
| `INVALID_PATH` | 路由没建、或触发路径写成了 `/admin/`、`admin`；也可能刚建完还在生效（等 5 分钟） |
| 打开是「后台页面缺失，请重新部署 admin 云函数」 | 云端函数里没读到 `public/index.html`；跑 `npm run cloud -- admin` 重新部署一次 |
| 页面空白 / 502 | 同上，或函数冷启动失败；看云函数日志 |
| 页面能开、登录说账号不存在 | 先在小程序点一次 **我的 → 电脑端后台**，服务端这时才生成账号和口令 |
| 小程序里复制的网址打不开，但控制台给的地址能开 | 就是第三节的域名不一致，把实际网址发我 |

## 六、为什么这一步只能人工点

- 微信开发者工具 CLI 的 `cloud functions` 只有 list / deploy / info / download，**没有路由或 service 命令**
- 腾讯云 `@cloudbase/cli` 有 `cloudbase service create -p /admin -f admin -e <env>`，
  但本机未安装，且要先装 CLI + 用腾讯云账号登录（密钥或扫码），为一条只配一次的路由引入密钥不划算
- 结论：**点一次，永久生效**，之后重新部署 `admin` 函数也不会丢路由

> 不配的后果只有一个：浏览器打不开电脑端后台。**小程序内所有功能不受影响**。
