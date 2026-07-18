scheduler.interval("script-interval-check", function scriptIntervalCheck() {
  scheduler.log("yaml scheduler script interval executed", { source: "full-yaml-e2e" });
  return scheduler.agent("Reply with exactly yaml-script-trigger-ok");
}, 86400000);

function main(payload) {
  scheduler.log("yaml scheduler script main executed", payload);
  return scheduler.agent("Reply with exactly yaml-script-main-ok");
}
