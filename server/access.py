"""Small shared-password gate for a private demo, not a user account system."""
from collections import OrderedDict, deque
import hashlib
import hmac
import secrets
import time

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse

LOGIN_PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>职升机 · 演示访问</title>
<style>body{font:16px system-ui;background:#f6f7fd;color:#192442;display:grid;place-items:center;min-height:95vh;margin:0}main{width:min(360px,85vw);padding:30px;background:white;border-radius:24px;box-shadow:0 15px 50px #40508012}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:10px;font:inherit}input{border:1px solid #d9deef}button{margin-top:16px;background:#6158ef;color:white;border:0;cursor:pointer}p{color:#6e7890;line-height:1.6}#error{color:#b24343;font-size:14px}</style>
<main><h1>职升机</h1><p>输入团队提供的演示口令，开始职业咨询。</p>
<form id="login"><input id="password" type="password" autocomplete="current-password" placeholder="演示访问口令" aria-label="演示访问口令" required maxlength="256"><button>进入演示</button></form><p id="error" role="status"></p></main>
<script>document.getElementById('login').onsubmit=async(e)=>{e.preventDefault();const p=document.getElementById('password');try{const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});p.value='';if(r.ok){location.href='/';return;}const j=await r.json();document.getElementById('error').textContent=j.message;}catch{document.getElementById('error').textContent='连接失败，请重试';}};</script></html>'''


class DemoAccess:
    def __init__(self, app, password='', required=False):
        self.app, self.password, self.required = app, password, required
        self.enabled = bool(password) or required
        self.attempts = OrderedDict()

    def ticket(self):
        payload = f'{int(time.time()) + 43200}.{secrets.token_hex(16)}'
        signature = hmac.new(self.password.encode(), payload.encode(), hashlib.sha256).hexdigest()
        return f'{payload}.{signature}'

    def authorized(self, cookie):
        if len(self.password) < 12 or not cookie:
            return False
        try:
            expiry, nonce, signature = cookie.split('.')
            if not int(time.time()) < int(expiry) <= int(time.time()) + 43200:
                return False
            expected = hmac.new(self.password.encode(), f'{expiry}.{nonce}'.encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(signature, expected)
        except (ValueError, TypeError):
            return False

    def allow_attempt(self, host):
        now = time.monotonic()
        if host not in self.attempts:
            if len(self.attempts) >= 1024:
                self.attempts.popitem(last=False)
            self.attempts[host] = deque()
        attempts = self.attempts[host]
        self.attempts.move_to_end(host)
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 5:
            return False
        attempts.append(now)
        return True

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket') or not self.enabled or scope['path'] == '/health':
            return await self.app(scope, receive, send)
        from starlette.datastructures import Headers
        from http.cookies import SimpleCookie, CookieError
        cookies = SimpleCookie()
        try:
            cookies.load(Headers(scope=scope).get('cookie', ''))
            cookie = cookies.get('demo_session')
        except CookieError:
            cookie = None
        permitted = self.authorized(cookie.value if cookie else '')
        if scope['type'] == 'websocket':
            if not permitted:
                await send({'type':'websocket.close', 'code':1008})
                return
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        if not self.password or len(self.password) < 12:
            response = HTMLResponse('<meta charset="utf-8">演示尚未开放：请管理员在部署平台设置至少 12 位的 DEMO_ACCESS_PASSWORD。', status_code=503)
        elif scope['path'] == '/auth/login' and request.method == 'POST':
            if not self.allow_attempt(request.client.host if request.client else 'unknown'):
                response = JSONResponse({'message':'尝试次数较多，请一分钟后重试'},status_code=429)
            else:
                try:
                    body = b''
                    async for part in request.stream():
                        body += part
                        if len(body) > 2048:
                            raise ValueError()
                    import json
                    value = json.loads(body).get('password')
                    if not isinstance(value,str) or len(value)>256:
                        raise ValueError()
                    if hmac.compare_digest(value.encode(), self.password.encode()):
                        response = JSONResponse({'ok':True})
                        response.set_cookie('demo_session', self.ticket(), max_age=43200, httponly=True,
                                            secure=self.required or request.url.scheme=='https', samesite='strict')
                    else:
                        response = JSONResponse({'message':'口令不正确'},status_code=401)
                except (ValueError, AttributeError):
                    response = JSONResponse({'message':'输入格式不正确'},status_code=400)
        elif permitted:
            return await self.app(scope, receive, send)
        elif scope['path'] in ('/', '/auth/login'):
            response = HTMLResponse(LOGIN_PAGE)
        else:
            response = JSONResponse({'message':'请先输入演示口令'},status_code=401)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        await response(scope,receive,send)
