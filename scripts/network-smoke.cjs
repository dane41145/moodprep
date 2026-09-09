const { app, net } = require('electron')

app.whenReady().then(async () => {
  try {
    const response = await net.fetch('https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image')
    console.log(`Chromium network reached Gemini with HTTP ${response.status}`)
    app.exit(0)
  } catch (error) {
    console.error(`Chromium network failed: ${error.message}`)
    app.exit(1)
  }
})
