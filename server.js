const express = require('express')
const app = express()
const port = 3000
const bodyParser = require('body-parser')

app.use(bodyParser.json())
app.post('/', require('.').githubImageCommenter)
app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`))
