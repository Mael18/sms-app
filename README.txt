FAMILY SMS BACKEND

WHAT THIS IS
A small Node.js server + web page that lets your family send SMS
through your SMS Gate cloud device (deviceId baked in, override via
SMS_DEVICE_ID). Protected by a shared PIN and basic rate limiting.

--------------------------------------------------------------------
OPTION A: LOCAL TEST (same Wi-Fi only, what you already tried)
--------------------------------------------------------------------
In Termux on the gateway phone:
   pkg install node
   cd ~/family-sms-backend
   export SMS_USER="YOUR_CLOUD_USERNAME"
   read -s -p "Cloud password: " SMS_PASS; echo
   export SMS_DEVICE_ID="Eeg7soiVJcToQDEDhKaR1"   # optional, this is the default
   export FAMILY_PIN="pick a PIN, e.g. 4821"
   node server.js

Then family on the same Wi-Fi opens: http://GATEWAY_PHONE_LAN_IP:3000

--------------------------------------------------------------------
OPTION B: DEPLOY TO YOUR OWN DOMAIN (works anywhere, not just Wi-Fi)
--------------------------------------------------------------------
This app has no dependency on the phone once deployed -- it only
calls the SMS Gate cloud API over the internet, so it can run on
any always-on host.

Recommended: Render.com (free/low-cost, automatic HTTPS, easy custom
domain). Steps:

1. Push this folder to a GitHub repo (or use Render's manual deploy
   / "Deploy from a zip" option if you don't want to use git).

2. In Render: New -> Web Service -> connect the repo.
   - Environment: Node
   - Build command: (leave blank / npm install)
   - Start command: npm start
   - Instance type: Free is fine to start

3. Add environment variables in Render's dashboard (Settings ->
   Environment):
     SMS_USER        = your SMS Gate cloud username
     SMS_PASS        = your SMS Gate cloud password
     SMS_DEVICE_ID   = Eeg7soiVJcToQDEDhKaR1
     FAMILY_PIN      = a PIN only your family knows (not "1234")
   Do NOT put these in the code or in the repo.

4. Deploy. Render gives you a URL like family-sms.onrender.com --
   confirm it works by opening it and sending a test text to
   yourself.

5. Point your domain at it:
   - In Render: Settings -> Custom Domains -> add e.g.
     sms.yourdomain.com
   - Render shows you a CNAME record to add.
   - In your domain registrar's DNS settings, add that CNAME record
     (usually: Type=CNAME, Name=sms, Value=<the one Render gives you>)
   - Wait for DNS to propagate (usually minutes, sometimes longer),
     then Render auto-issues an HTTPS certificate for it.

6. Share https://sms.yourdomain.com with your family, along with
   the FAMILY_PIN (send the PIN a different way than the link,
   e.g. tell them in person or a private chat).

Any Node-friendly host works the same way (Railway, Fly.io, a VPS
with Caddy for automatic HTTPS, etc.) -- the steps are the same:
set the four env vars, run `npm start`, put a domain in front of it.

--------------------------------------------------------------------
SECURITY NOTES
--------------------------------------------------------------------
- The site now requires a shared PIN (FAMILY_PIN) before it will
  send anything. Give the PIN only to family, not the link+PIN in
  the same message/channel.
- Sending is rate-limited to 10 messages per 10 minutes per visitor,
  to stop runaway costs from a bug or misuse.
- Credentials (SMS_USER/SMS_PASS) and the PIN live only in
  environment variables on the host -- never in the code or repo.
- Contacts are stored per-device in the browser's local storage,
  not shared across family members.
- Every send targets your specific device via deviceId, so messages
  always go out through that phone/SIM even if other devices are
  registered on the account.

