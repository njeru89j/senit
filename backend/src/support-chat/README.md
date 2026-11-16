# SendIT Assist

The chatbot uses public project knowledge from `support-knowledge.ts`, verified
database lookups for tracking/coverage, and local Ollama for other help questions.
This is runtime grounding, not model-weight training. Update the curated knowledge
when the delivery or account workflows change; do not add secrets or customer data.

Local configuration in `backend/.env`:

```dotenv
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:0.8b
```

Run Ollama on the same machine as the backend, download the configured model, and
restart the backend after changing its environment. Common help questions still
work when Ollama is unavailable. Model requests use a 2048-token context, limited
output and a one-minute idle lifetime to reduce memory use.

`POST /api/support-chat/message` accepts `{ "message": "..." }` without a token.
A supplied bearer token must pass the normal account validation. A tracking ID
allows public status/location/ETA lookup; personal addresses, history notes and
collection codes are not included in that lookup. Without an ID, account parcel
queries require authentication and filter by sender/recipient ownership.

The response may include `trackingNumber` for status follow-ups, `requiresTracking`
to show the tracking/login prompt, and suggested questions. A follow-up can send
`trackingNumber` alongside its message; it is always validated and re-queried.

Validation: `node node_modules/jest/bin/jest.js --runInBand support-chat.service.spec.ts`
