const jsonwebtoken = require('jsonwebtoken')
const { Octokit } = require('@octokit/rest')
const { createAppAuth } = require('@octokit/auth-app')

const appId = process.env.APP_ID
const privateKey = Buffer.from(process.env.PRIVATE_KEY, 'base64')

async function githubImageCommenter (req, res) {
  console.info(req.body)
  const client = await getClient(req.body.installation_id || process.env.INSTALLATION_ID)
  /*await client.actions.listWorkflowRunLogs({
    owner,
    repo,
    run_id,
  });*/
  res.status(200).send({status: 'ok'})
}

/*
octokit.actions.listWorkflowJobLogs({
  owner,
  repo,
  job_id,
});
*/

async function getClient (installationId) {
  const appClient = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      id: appId,
      privateKey: privateKey
    }
  })
  const { token } = await appClient.auth({
    type: "installation",
    installationId: installationId
  });
  return new Octokit({
    auth: token
  })
}

module.exports = {
  githubImageCommenter
}
