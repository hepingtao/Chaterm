// Build-time stub: ssh2 optionally requires the native `cpu-features` module.
// The CLI bundle aliases `cpu-features` to this file so esbuild/pkg never try
// to resolve the real (absent) native module. ssh2 wraps the require in
// try/catch and degrades gracefully.
module.exports = {}
