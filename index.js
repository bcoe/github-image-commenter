const { createAppAuth } = require('@octokit/auth-app')
const { createWriteStream } = require('fs')
const { writeFile } = require('fs').promises
const crypto = require('crypto')
const fetch = require('node-fetch')
const { mkdir } = require('fs').promises
const { Octokit } = require('@octokit/rest')
const { PassThrough } = require('stream')
const { v4 } = require('uuid')
const yauzl = require('yauzl')

// Task queue used to move from temporary holding area for screenshots
// to public bucket for posting to GitHub
const QUEUE_NAME = 'github-image-commenter'
// Public bucket to place the screen shots posted to GitHub in:
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET
// Private staging area for screen shots (this data has not yet been validated):
const TMP_BUCKET = process.env.TMP_BUCKET
// URL of the cloud function itself (this is used when enqueing to cloud
// tasks, which calls the same function).
const GITHUB_IMAGE_COMMENTER_FUNCTION = process.env.GITHUB_IMAGE_COMMENTER_FUNCTION
const LOCATION = process.env.GCF_LOCATION || 'us-west2'
// GitHub app ID and private key:
const APP_ID = process.env.APP_ID
const PRIVATE_KEY = Buffer.from(process.env.PRIVATE_KEY, 'base64')
const INSTALLATION_ID = process.env.INSTALLATION_ID

let task
const { CloudTasksClient } = require('@google-cloud/tasks')
let storage
const { Storage } = require('@google-cloud/storage')
async function githubImageCommenter (req, res) {
  if (!storage) {
    storage = new Storage()
    task = new CloudTasksClient()
  }

  // If no task ID is set, assume that this PR originated from a GitHub
  // Action and enqueue a task to upload screen-shots to a public folder
  // once action logs are available:
  const taskId = req.headers['X-CloudTasks-TaskName'] || req.headers['x-cloudtasks-taskname']
  if (!taskId) {
    // Make sure that all the required fields are set:
    const requiredFields = ['pull_number', 'repository', 'run_id', 'action_log_file', 'images']
    for (const field of requiredFields) {
      if (!req.body[field]) {
        const message = `missing required field ${field}`
        console.warn(message)
        return res.status(400).send({ message })
      }
    }
    // Upload the request body to a private temporary folder, we do not yet
    // trust the screen shots that have been uploaded:
    const id = v4()
    const tmpFile = `/tmp/${id}`
    await writeFile(tmpFile, JSON.stringify(req.body), 'utf8')
    await storage.bucket(TMP_BUCKET).upload(tmpFile, {
      // Support for HTTP requests made with `Accept-Encoding: gzip`
      gzip: true,
      // By setting the option `destination`, you can change the name of the
      // object you are uploading to a bucket.
      metadata: {
        cacheControl: 'public, max-age=31536000'
      }
    })
    // Enqueue a task that will finish the screen shot uploading.
    await enqueueTask(id, task)
  } else {
    // Reload the POST body of screenshots, which was created in the initial
    // request. This is necessary because GitHub Action logs are not
    // available until a few seconds after the screenshots are uploaded...
    console.info(`called from task ${taskId}`)
    const bodyFile = '/tmp/body.json'
    await storage.bucket(TMP_BUCKET).file(req.body.request_id).download({
      destination: bodyFile
    })
    const body = require(bodyFile)

    // We fetch the GitHub action logs from GitHub. These logs have the SHA256
    // of the visual integration test logged inside them. We can use this to
    // validate that the image being uploaded was actually present in a
    // GitHub Action test run:
    const github = await getGitHubClient(INSTALLATION_ID)
    const logs = await getTestLogs(github, body.repository, body.run_id, body.action_log_file)

    let comment = ':wave: there have been some regressions in the visual integration tests.\n\nThe images attached below demonstrate the observed, vs., expected rendering of the site:\n\n'
    for (const image of body.images) {
      // For each image uploaded in the previous step, validate that its SHA256
      // value exists in the GitHub action logs:
      const sha = getSha256Hash(image.content)
      console.info(`attempt to find sha ${sha} in logs`)
      if (!logs.includes(sha)) {
        const message = 'screenshot sha not found in action logs'
        console.warn(message)
        return res.status(400).send({ status: message })
      } else {
        // Now that we've validated that the screenshot originated in the
        // appropriate GitHub action test run, move it into the public bucket:
        await writeFile(`/tmp/${image.sha}.png`, Buffer.from(image.content, 'base64'))
        await storage.bucket(PUBLIC_BUCKET).upload(`/tmp/${image.sha}.png`, {
          // Support for HTTP requests made with `Accept-Encoding: gzip`
          gzip: true,
          // By setting the option `destination`, you can change the name of the
          // object you are uploading to a bucket.
          metadata: {
            cacheControl: 'public, max-age=31536000'
          }
        })
        comment += `**${image.name}**\n\n![${image.name}](https://storage.googleapis.com/${PUBLIC_BUCKET}/${image.sha}.png)\n\n`
      }
    }
    comment += 'See **DEV_DOCS.md** for tips on running tests locally.'

    // Actually leave a comment on the pull request:
    const [owner, repo] = body.repository.split('/')
    await github.issues.createComment({
      owner,
      repo,
      issue_number: body.pull_number,
      body: comment
    })
  }
  return res.status(200).send({ status: 'ok' })
}

// Places a job in cloud tasks which will actually complete the upload:
async function enqueueTask (requestId, task) {
  const queuePath = task.queuePath(await task.getProjectId(), LOCATION, QUEUE_NAME)
  console.info(`enqueue task id = ${requestId} path = ${queuePath} url = ${GITHUB_IMAGE_COMMENTER_FUNCTION}`)
  const result = await task.createTask({
    parent: queuePath,
    task: {
      httpRequest: {
        httpMethod: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        url: GITHUB_IMAGE_COMMENTER_FUNCTION,
        body: Buffer.from(JSON.stringify({
          request_id: requestId
        }))
      },
      scheduleTime: {
        seconds: 10 + Date.now() / 1000
      }
    }
  })
  console.info(result)
}

// A GitHub API client, scoped to a specific installation:
async function getGitHubClient (installationId) {
  console.info(`fetch client for intallation ${installationId}`)
  const appClient = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      id: APP_ID,
      privateKey: PRIVATE_KEY
    }
  })
  const { token } = await appClient.auth({
    type: 'installation',
    installationId: installationId
  })
  return new Octokit({
    auth: token
  })
}

// SHA256 hash used to validate that the images uploaded match the images
// generated during the integration test run:
function getSha256Hash (body) {
  return crypto.createHash('sha256')
    .update(body)
    .digest('hex')
}

// Fetches GitHub action test logs, so that we can confirm the screenshot
// upload originated from GitHub:
async function getTestLogs (github, repository, runId, actionLogFile) {
  const [owner, repo] = repository.split('/')
  const unpackPath = `/tmp/${v4()}`
  await mkdir(unpackPath, { recursive: true })
  console.info(`unpack logs to ${unpackPath}`)
  const logsResponse = await github.actions.listWorkflowRunLogs({
    owner,
    repo,
    run_id: runId
  })
  console.info(`found logs URL ${logsResponse.url}`)
  // Output zip file of logs temporarily:
  await fetch(logsResponse.url, { compress: false }).then(res => {
    return new Promise((resolve, reject) => {
      res.body.pipe(createWriteStream(`${unpackPath}/out.zip`))
        .on('error', reject)
        .on('close', () => {
          console.info(`wrote zip file to ${unpackPath}`)
          return resolve()
        })
    })
  })
  // Iterate over logs in memory, looking for the integration test output:
  console.info(`looking for logs matching ${actionLogFile}`)
  return new Promise((resolve, reject) => {
    yauzl.open(`${unpackPath}/out.zip`, { lazyEntries: true }, (err, zipfile) => {
      let data = ''
      if (err) return reject(err)
      zipfile.readEntry()
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory file names end with '/'.
          // Note that entires for directories themselves are optional.
          // An entry's fileName implicitly requires its parent directories to exist.
          zipfile.readEntry()
        } else {
          // file entry
          zipfile.openReadStream(entry, function (err, readStream) {
            if (err) return reject(err)
            console.info(`found entry ${entry.fileName}`)
            const pass = new PassThrough()
            pass.on('data', chunk => {
              if (entry.fileName.includes(actionLogFile)) {
                data += chunk.toString()
              }
            })
            readStream.on('end', function () {
              zipfile.readEntry()
            })
            readStream.pipe(pass)
          })
        }
      })
      zipfile.on('close', () => {
        return resolve(data)
      })
    })
  })
}

module.exports = {
  githubImageCommenter
}
