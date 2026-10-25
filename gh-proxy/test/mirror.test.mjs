// 整站镜像重写规则的本地单元测试。
// 跑法：node --test gh-proxy/test/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rewriteHTML,
  rewriteLocation,
  rewriteSetCookie,
  isMirrorRequest,
} from '../worker.js';

const ORIGIN = 'https://github-proxy.xiaosh.xyz';

const decodeProxyValue = url => {
  const match = url.match(/^https:\/\/github-proxy\.xiaosh\.xyz\/\?url=(.+)$/);

  assert.ok(match, `不是 ?url= 形式：${url}`);

  return decodeURIComponent(match[1]);
};

test('github.com 绝对地址改写成镜像同源', () => {
  const out = rewriteHTML(
    '<a href="https://github.com/oven-sh/bun">x</a>',
    ORIGIN
  );

  assert.equal(out, `<a href="${ORIGIN}/oven-sh/bun">x</a>`);
});

test('页面里所有 github.com 绝对地址都被改写', () => {
  const input =
    '<a href="https://github.com/a">1</a>' +
    '<img src="https://github.com/b/x.png">' +
    '<form action="https://github.com/session">';

  const out = rewriteHTML(input, ORIGIN);

  assert.equal(out.includes('https://github.com'), false);
  assert.equal(out.match(/github-proxy\.xiaosh\.xyz/g).length, 3);
});

test('协议相对 //github.com 改写', () => {
  const out = rewriteHTML('<script src="//github.com/x.js"></script>', ORIGIN);

  assert.equal(out, '<script src="//github-proxy.xiaosh.xyz/x.js"></script>');
});

test('形似域名不被误伤', () => {
  const input = 'https://github.com.cnpmjs.org/x and https://github.company.com/';

  assert.equal(rewriteHTML(input, ORIGIN), input);
});

test('根相对路径保持原样（默认路由已兜住）', () => {
  const input = '<a href="/login">登录</a><img src="/assets/a.png">';

  assert.equal(rewriteHTML(input, ORIGIN), input);
});

test('githubusercontent 资源走 ?url= 代理', () => {
  const out = rewriteHTML(
    '<img src="https://avatars.githubusercontent.com/u/1?s=64&amp;v=4">',
    ORIGIN
  );

  const url = out.match(/src="([^"]+)"/)[1];

  assert.equal(
    decodeProxyValue(url),
    'https://avatars.githubusercontent.com/u/1?s=64&v=4'
  );
});

test('codeload 走 ?url= 代理', () => {
  const out = rewriteHTML(
    'https://codeload.github.com/octocat/Hello-World/zip/refs/heads/master',
    ORIGIN
  );

  assert.equal(
    decodeProxyValue(out),
    'https://codeload.github.com/octocat/Hello-World/zip/refs/heads/master'
  );
});

test('重定向到 github.com 改成同源路径', () => {
  assert.equal(
    rewriteLocation('https://github.com/login?return_to=%2Fissues', ORIGIN),
    '/login?return_to=%2Fissues'
  );
});

test('重定向到资源域改走 ?url=', () => {
  const out = rewriteLocation(
    'https://githubusercontent.com/a/b.png',
    ORIGIN
  );

  assert.equal(decodeProxyValue(out), 'https://githubusercontent.com/a/b.png');
});

test('重定向到第三方域保持原样', () => {
  assert.equal(
    rewriteLocation('https://example.com/x', ORIGIN),
    'https://example.com/x'
  );
});

test('Cookie 去掉 Domain，保留其余属性', () => {
  assert.equal(
    rewriteSetCookie('_gh_sess=abc; Domain=.github.com; Path=/; Secure'),
    '_gh_sess=abc; Path=/; Secure'
  );

  assert.equal(
    rewriteSetCookie('logged_in=no; Domain=github.com; Path=/'),
    'logged_in=no; Path=/'
  );
});

test('镜像请求识别：普通路径进镜像，两个老入口不进', () => {
  const mirror = (url) => isMirrorRequest(new URL(url, ORIGIN));

  assert.equal(mirror('/'), true);
  assert.equal(mirror('/oven-sh/bun'), true);
  assert.equal(mirror('/x?tab=readme-ov-file'), true);
  assert.equal(mirror('/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fa'), false);
  assert.equal(mirror('/https://github.com/oven-sh/bun'), false);
  assert.equal(mirror('/http://github.com/oven-sh/bun'), false);
});
