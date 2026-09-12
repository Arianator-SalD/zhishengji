import time
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from server.main import create_app
from server.providers import Providers
from server.settings import Settings
from server.access import DemoAccess

# A deliberately public test-only password, unrelated to any deployed credential.
PASSWORD = 'test-only-public-password'


def client(password=PASSWORD, required=False):
    return TestClient(create_app(Settings(allowed_hosts=('testserver',),
                      demo_access_password=password, require_access_password=required), Providers()),
                      base_url='https://testserver')


def test_gate_protects_content_and_websocket():
    with client() as c:
        assert '演示访问口令' in c.get('/').text
        assert c.get('/api/config').status_code == 401
        assert c.get('/static/index.html').status_code == 401
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect('wss://testserver/ws/voice'):
                pass
        assert c.get('/health').status_code == 200


def test_login_cookie_allows_browser_and_websocket_but_never_returns_password():
    with client(required=True) as c:
        r = c.post('/auth/login',json={'password':PASSWORD})
        assert r.status_code == 200
        cookie = r.headers['set-cookie']
        assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=strict' in cookie
        assert PASSWORD not in cookie + r.text
        assert '职升机' in c.get('/').text
        assert c.get('/api/config').status_code == 200
        with c.websocket_connect('wss://testserver/ws/voice',headers={'origin':'https://testserver'}) as ws:
            ws.send_json({'type':'session.start'})
            assert ws.receive_json()['type'] == 'session.ready'


@pytest.mark.parametrize('password',['','short'])
def test_cloud_fails_closed_without_sufficient_password(password):
    with client(password,required=True) as c:
        assert c.get('/').status_code == 503
        assert c.get('/api/config').status_code == 503
        assert c.get('/health').status_code == 200


def test_login_attempt_limit_and_oversized_input():
    with client() as c:
        assert c.post('/auth/login',content='x'*2049).status_code == 400
        for _ in range(4):
            assert c.post('/auth/login',json={'password':'wrong'}).status_code == 401
        assert c.post('/auth/login',json={'password':PASSWORD}).status_code == 429


def test_ticket_tampering_and_password_rotation():
    gate = DemoAccess(None,password=PASSWORD)
    ticket = gate.ticket()
    assert gate.authorized(ticket)
    assert not gate.authorized(ticket[:-1] + ('0' if ticket[-1]!='0' else '1'))
    assert not DemoAccess(None,password='rotated-test-password').authorized(ticket)
    assert not gate.authorized(f'{int(time.time())-1}.nonce.signature')


def test_render_hostname_enforces_access_gate(monkeypatch):
    monkeypatch.setenv('RENDER_EXTERNAL_HOSTNAME','demo.onrender.com')
    monkeypatch.setenv('REQUIRE_ACCESS_PASSWORD','false')
    s=Settings.from_env()
    assert s.require_access_password
    assert 'demo.onrender.com' in s.allowed_hosts


def test_websocket_concurrency_limit_releases_after_close():
    with client() as c:
        c.post('/auth/login',json={'password':PASSWORD})
        with c.websocket_connect('wss://testserver/ws/voice'), c.websocket_connect('wss://testserver/ws/voice'), c.websocket_connect('wss://testserver/ws/voice'):
            with pytest.raises(WebSocketDisconnect):
                with c.websocket_connect('wss://testserver/ws/voice'):
                    pass
        with c.websocket_connect('wss://testserver/ws/voice') as ws:
            ws.send_json({'type':'session.start'})
            assert ws.receive_json()['type']=='session.ready'
