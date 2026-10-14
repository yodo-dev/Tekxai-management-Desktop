# TEKxAI Agent — Windows v1.3.0 UAT Checklist

**Please read this whole box before starting.**

- You do **not** need to know anything about the codebase to run this.
- Use the artifact you already have: **`TEKxAI Agent Setup 1.3.0.exe`**
- This build must come from: tag **`v1.3.0`**, commit **`66ea751`**
- **Do not** rebuild, recompile, or modify anything — this is a test of the exact file you already have.
- **Do not** publish, register, or announce this release — that decision happens after your results come back.
- Use a test/authorized TekXAI account, not a real employee's or client's account/data, unless a step specifically requires clocking in with your own account.
- For each test below, mark **PASS**, **FAIL**, or **NOT TESTED**, and add a screenshot where it says "evidence" if you can.
- If anything fails, don't try to fix it — just record exactly what happened (error message, screenshot, what you clicked) and send it back as-is.

---

## 1. Installation

- [ ] Run `TEKxAI Agent Setup 1.3.0.exe`
- [ ] Complete the install wizard
- [ ] Installation finishes without an error

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 2. Launch

- [ ] Open the installed TEKxAI Agent
- [ ] App opens — no crash
- [ ] No blank/white window
- [ ] Right-click the app icon (or check Help/About if there is one) and confirm the version shown is **1.3.0**

**Result:** PASS / FAIL / NOT TESTED
**Evidence:** (screenshot of the app window, and of the version number if visible)

## 3. Login

- [ ] Log in with your test/authorized TekXAI account
- [ ] Dashboard/main screen loads after login
- [ ] No errors appear

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 4. Clock-In

- [ ] Click **Clock In**
- [ ] The app shows you as actively clocked in (timer running)
- [ ] Leave the app open and running for a few minutes
- [ ] No errors or crashes happen while it's running

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 5. Activity Heartbeat (new in 1.3.0)

This is the main new feature in this release — please give it a bit of extra attention.

- [ ] While clocked in, leave the app running and stay on your computer normally (don't need to do anything special) for **at least 1 minute**
- [ ] If you're able to check with IT/a developer for backend or network logs: confirm the app is sending small periodic requests roughly every 45 seconds
- [ ] Confirm the app keeps working normally the whole time — no popup, no slowdown, no crash
- [ ] You do **not** need to verify the technical contents of these requests yourself — just confirm nothing broke and the timer/attendance kept working normally. (If you do have log access: the request should only ever contain a number of idle seconds, the app name, and the app version — never any typed text, keystrokes, or mouse-click content.)

**Result:** PASS / FAIL / NOT TESTED
**Evidence:** (network/log screenshot if available, otherwise just confirm nothing broke)

## 6. Break

- [ ] Start a break from within the app
- [ ] App shows you as on break
- [ ] End the break
- [ ] App correctly shows you as active/working again (not stuck on break, not showing 0h:00m again)

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 7. Logout

- [ ] Log out of the app
- [ ] You're returned to the login screen
- [ ] Log back in again with the same account
- [ ] Login works a second time, and the app doesn't show a broken/invalid session

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 8. Restart

- [ ] Fully close the app and reopen it (or restart your computer if convenient)
- [ ] App opens normally — no crash, no blank screen
- [ ] Version still shows **1.3.0**
- [ ] You're either still logged in, or asked to log in normally — nothing looks broken or stuck

**Result:** PASS / FAIL / NOT TESTED
**Evidence:**

## 9. Auto-Update (only if you happen to have a 1.2.5 install available)

**Skip this section if you don't already have a working 1.2.5 installed** — do not install 1.2.5 specially just for this test, and do not try to trigger this manually. This is a "nice to have if it's already sitting there," not a requirement.

- [ ] If a 1.2.5 install is already running and connected to the normal production update channel, just note whether it shows any update prompt
- [ ] Do NOT expect it to update to 1.3.0 yet — this release hasn't been published/registered on purpose, so 1.2.5 should currently **not** find anything

**Result:** PASS / FAIL / NOT TESTED / SKIPPED
**Evidence:**

---

## Final Summary

Please fill this in once you're done with everything above:

| Test | Result | Evidence |
|---|---|---|
| Installer | | |
| Launch | | |
| Version 1.3.0 | | |
| Login | | |
| Clock-in | | |
| Activity heartbeat | | |
| Break | | |
| Logout | | |
| Restart | | |
| Auto-update | | |

**Anything else you noticed, even if minor:**


---

Once you're done, send this whole document (with your results filled in, plus any screenshots) back — no need to interpret or summarize it further, just report exactly what you saw.
