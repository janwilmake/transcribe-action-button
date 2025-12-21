Apple made it notoriously hard to build your own Siri, except that they left one loophole open: the action button can be connected to a Shortcut, which can be set to call a contact.

This repo contains a way for you to create an AI contact that transcribes the recording and deletes it, then sends the transcript to your email, making this a fully GDPR proof solution.

From the email, you can further connect it to all kinds of AI tools using platforms like Zapier, Make, or N8N.

To set this up, you need accounts at Cloudflare, Deepgram, Cloudflare Email, and Twilio, and copy the [.env.example](.env.example) to [.env](.env), then fill the required secrets from the respective accounts. Also, be sure to deploy this worker on Cloudflare using [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

TODO

- Update to use [Cloudflare email](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) rather than Sendgrid, which costs $30/month
- Set it up for myself with Cloudflare email

IDEAS

- Instead of emailing a transcript, connect this to the [Parallel Task API](https://parallel.ai) and create a simple dashboard for your past researches. It may be better to connecgt it to the [Parallel Task MCP](https://github.com/parallel-web/task-mcp)
- Instead of task API, connect it to your personal file system so you can do any type of generations from here, or also, just make notes.
- **Monetize this**: add a way so people can easily monetize this as a SaaS connected to Parallel.

Challenges

- **Voice Entity Resolution** is a major challenge, and maybe Deepgram has better solutions for this these days that I'm unaware of. If we have better context we can properly transcribe names of repos, contacts, companies, etc. This'd be huge for voice. It must be possible as products like [Whispr Flow](https://wisprflow.ai) has succesfully solved this
