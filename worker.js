export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.hostname.startsWith("2048.") ? "/2048.html" : "/index.html";
    return env.ASSETS.fetch(new Request(new URL(path, request.url)));
  },
};
