export default {
  async email(message, env) {
    const from = message.from
    const to = message.to
    const subject = message.headers.get('subject') || '(no subject)'

    // Read the email body
    const rawEmail = new Response(message.raw)
    const body = await rawEmail.text()

    // Extract plain text (rough — good enough for v0)
    let plainText = body
    const textMatch = body.match(/Content-Type: text\/plain[\s\S]*?\n\n([\s\S]*?)(?:\n--|\n\n--|\Z)/i)
    if (textMatch) {
      plainText = textMatch[1].trim()
    }

    // Truncate to avoid massive payloads
    if (plainText.length > 2000) {
      plainText = plainText.substring(0, 2000) + '... [truncated]'
    }

    console.log(`[email] from=${from} to=${to} subject=${subject}`)

    // Forward to OpenClaw via tunnel
    if (env.HOOK_URL) {
      try {
        const hookRes = await fetch(env.HOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.HOOK_TOKEN || ''}`
          },
          body: JSON.stringify({
            text: `[email] From: ${from} | Subject: ${subject} | Body: ${plainText}`
          })
        })
        console.log(`[email] hook response: ${hookRes.status}`)
      } catch (err) {
        console.log(`[email] hook failed: ${err.message}`)
      }
    }
  }
}
