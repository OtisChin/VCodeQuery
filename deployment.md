# Deployment Guide

本文档说明如何在本地运行该项目，以及如何部署到 Cloudflare Workers。

## 本地运行

### 1. 准备环境变量

复制示例文件：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，至少填写：

```env
MAIL_GATEWAY_ACCOUNTS=[{"email":"your-login-email@example.com","password":"your-password"}]
```

可选项：

```env
MAIL_GATEWAY_BASE_URL=https://mail.970410.xyz/api
MAIL_GATEWAY_LOGIN_EMAIL=your-login-email@example.com
MAIL_GATEWAY_PASSWORD=your-password
PORT=3000
```

说明：

- 推荐使用 `MAIL_GATEWAY_ACCOUNTS`
- 该变量是 JSON 数组，支持多个登录账号
- 如果未设置 `MAIL_GATEWAY_ACCOUNTS`，系统会回退使用单账号配置

### 2. 启动本地服务

```powershell
node server.js
```

### 3. 访问页面

浏览器打开：

```text
http://127.0.0.1:3000
```

如果你在 `.env` 中修改了 `PORT`，请使用对应端口访问。

## Cloudflare Workers 部署

### 1. 安装依赖

```powershell
npm install
```

### 2. 登录 Cloudflare

```powershell
npx wrangler login
```

### 3. 配置生产环境 Secrets

```powershell
npx wrangler secret put MAIL_GATEWAY_ACCOUNTS
```

示例值：

```json
[{"email":"a@example.com","password":"123456"},{"email":"b@example.com","password":"abcdef"}]
```

如果你仍然只想使用单账号，也可以继续配置：

```powershell
npx wrangler secret put MAIL_GATEWAY_LOGIN_EMAIL
npx wrangler secret put MAIL_GATEWAY_PASSWORD
```

如果你的中转站 API 地址不是默认值，再执行：

```powershell
npx wrangler secret put MAIL_GATEWAY_BASE_URL
```

默认地址是：

```text
https://mail.970410.xyz/api
```

### 4. 本地预览 Worker

```powershell
npm run dev
```

### 5. 部署到 Cloudflare

```powershell
npm run deploy
```

部署完成后，Cloudflare 会提供一个 `*.workers.dev` 地址。

## 自定义域名

如果你要绑定自己的域名，可以在 [wrangler.jsonc](D:\code\my\VCodeQuery\wrangler.jsonc) 中添加：

```json
{
  "routes": [
    {
      "pattern": "code.yourdomain.com",
      "custom_domain": true
    }
  ]
}
```

然后重新执行：

```powershell
npm run deploy
```

## 注意事项

- 正式环境不要把邮箱账号密码写死在代码中
- Cloudflare 线上环境请使用 `wrangler secret put`
- 本地 Node 版和 Worker 版使用的是同一套业务逻辑，但入口不同
- 如果浏览器仍显示旧样式，先关闭旧进程，再重新启动服务
