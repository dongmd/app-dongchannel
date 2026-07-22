// Shim để tsx test script bypass 'server-only' package (chỉ throw khi không có Next.js webpack alias).
// Trong runtime thật (Next.js server route), Next tự alias sang empty module.
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "server-only") return require.resolve("./server-only-empty.cjs");
  return origResolve.call(this, request, parent, ...rest);
};
