// Invite-code gate page logic (kept external so the page CSP can stay strict).
const input = document.getElementById("code");
const button = document.getElementById("submit");
const error = document.getElementById("error");

async function submit() {
  const code = input.value.trim();
  if (!code) { error.textContent = "请输入邀请码"; return; }
  button.disabled = true;
  error.textContent = "";
  try {
    const result = await window.openswarm.activate(code);
    if (!result.ok) {
      error.textContent = result.message || "邀请码无效";
      button.disabled = false;
      input.select();
    }
    // Success path: main process closes this window and continues booting.
  } catch (e) {
    error.textContent = "校验失败，请重试";
    button.disabled = false;
  }
}

button.addEventListener("click", submit);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
