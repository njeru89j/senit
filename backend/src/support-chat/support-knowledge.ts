// Curated from app.routes.ts, parcel workflows and the destination locker workflow.
// Keep this public help content in sync when product behavior changes.
export const SUPPORT_KNOWLEDGE = [
  { match: /\b(hello|hi|hey|help|what is sendit|what can you)\b/i, answer: 'SendIT helps you create, track and manage parcel deliveries. I can explain delivery requests, tracking, transit points and locker collection. You can chat without an account. To track a parcel, paste its tracking ID or sign in to see your own parcels.' },
  { match: /\b(track|tracking)\b/i, answer: 'Paste your SendIT tracking ID here or use the Track page at /track. You do not need to sign in when you have a tracking ID. Sign in to see parcels you sent or are receiving and their private collection instructions.' },
  { match: /\b(locker|collection|collect|pickup code)\b/i, answer: 'A destination transit officer can assign a locker after verifying the parcel at its destination transit point. Sign in and open your parcel details to view private collection instructions and your collection code. Never share that code in chat.' },
  { match: /\b(create|send|book|request|delivery work)\b/i, answer: 'Sign in as a customer, open your dashboard and choose Create Parcel (/user/create-parcel). Enter the sender, recipient and parcel details, select the available delivery options, and review the request before submitting. Your tracking number identifies the parcel throughout delivery.' },
  { match: /\b(password|reset|forgot)\b/i, answer: 'Use the password reset page at /reset and follow the instructions sent to your account email. Do not send your password or reset token in this chat.' },
  { match: /\b(sign up|signup|register|account|log in|login|sign in)\b/i, answer: 'Create an account at /signup or sign in at /login. Your customer dashboard shows parcels you sent or are receiving. General help and tracking by tracking ID are available without signing in.' },
  { match: /\b(price|cost|fee|charge|refund|insurance|guarantee)\b/i, answer: 'I cannot verify a price, refund policy or delivery guarantee from the help information. Check the details shown for your delivery request or contact SendIT support before confirming.' },
];

export const SUPPORT_SOURCE = SUPPORT_KNOWLEDGE.map((entry) => entry.answer).join('\n');
