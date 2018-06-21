import { debug } from "../../debug"
import * as node_fetch from "node-fetch"
import v from "voca"

import {
  BitBucketServerPRDSL,
  BitBucketServerCommit,
  BitBucketServerPRComment,
  JIRAIssue,
  BitBucketServerPRActivity,
  BitBucketServerDiff,
  RepoMetaData,
} from "../../dsl/BitBucketServerDSL"
import { Comment } from "../platform"

import { Env } from "../../ci_source/ci_source"
import { dangerSignaturePostfix, dangerIDToString } from "../../runner/templates/bitbucketServerTemplate"
import { api as fetch } from "../../api/fetch"

// Note that there are parts of this class which don't seem to be
// used by Danger, they are exposed for Peril support.

export interface BitBucketRepoCredentials {
  host: string
  username?: string
  password?: string
}

export function bitbucketServerRepoCredentialsFromEnv(env: Env): BitBucketRepoCredentials {
  if (!env["DANGER_BITBUCKETSERVER_HOST"]) {
    throw new Error(`DANGER_BITBUCKETSERVER_HOST is not set`)
  }
  return {
    host: env["DANGER_BITBUCKETSERVER_HOST"],
    username: env["DANGER_BITBUCKETSERVER_USERNAME"],
    password: env["DANGER_BITBUCKETSERVER_PASSWORD"],
  }
}

/** This represent the BitBucketServer API */

export class BitBucketServerAPI {
  fetch: typeof fetch
  private readonly d = debug("BitBucketServerAPI")

  private pr: BitBucketServerPRDSL | undefined

  constructor(public readonly repoMetadata: RepoMetaData, public readonly repoCredentials: BitBucketRepoCredentials) {
    // This allows Peril to DI in a new Fetch function
    // which can handle unique API edge-cases around integrations
    this.fetch = fetch
  }

  getPRBasePath(service = "api") {
    const { repoSlug, pullRequestID } = this.repoMetadata
    return `rest/${service}/1.0/${repoSlug}/pull-requests/${pullRequestID}`
  }

  getPullRequestsFromBranch = async (branch: string): Promise<BitBucketServerPRDSL[]> => {
    const { repoSlug } = this.repoMetadata
    const path = `rest/api/1.0/${repoSlug}/pull-requests?at=refs/heads/${branch}&withProperties=false&withAttributes=false`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values as BitBucketServerPRDSL[]
  }

  getPullRequestInfo = async (): Promise<BitBucketServerPRDSL> => {
    if (this.pr) {
      return this.pr
    }
    const path = this.getPRBasePath()
    const res = await this.get(path)
    throwIfNotOk(res)
    const prDSL = (await res.json()) as BitBucketServerPRDSL
    this.pr = prDSL
    return prDSL
  }

  getPullRequestCommits = async (): Promise<BitBucketServerCommit[]> => {
    const path = `${this.getPRBasePath()}/commits`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getStructuredDiff = async (base: string, head: string): Promise<BitBucketServerDiff[]> => {
    const { repoSlug } = this.repoMetadata
    const path = `rest/api/1.0/${repoSlug}/compare/diff?withComments=false&from=${base}&to=${head}`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).diffs
  }

  getPullRequestDiff = async (): Promise<BitBucketServerDiff[]> => {
    const path = `${this.getPRBasePath()}/diff?withComments=false`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).diffs
  }

  getPullRequestComments = async (): Promise<BitBucketServerPRActivity[]> => {
    const path = `${this.getPRBasePath()}/activities?fromType=COMMENT`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getPullRequestActivities = async (): Promise<BitBucketServerPRActivity[]> => {
    const path = `${this.getPRBasePath()}/activities?fromType=ACTIVITY`
    const res = await this.get(path)
    throwIfNotOk(res)
    return (await res.json()).values
  }

  getIssues = async (): Promise<JIRAIssue[]> => {
    const path = `${this.getPRBasePath("jira")}/issues`
    const res = await this.get(path)
    throwIfNotOk(res)
    return await res.json()
  }

  getDangerComments = async (dangerID: string): Promise<BitBucketServerPRComment[]> => {
    const username = this.repoCredentials.username
    const activities = await this.getPullRequestComments()
    const dangerIDMessage = dangerIDToString(dangerID)

    const comments = activities.map(activity => activity.comment).filter(Boolean) as BitBucketServerPRComment[]

    return comments
      .filter(comment => v.includes(comment!.text, dangerIDMessage))
      .filter(comment => username || comment!.author.name === username)
      .filter(comment => v.includes(comment!.text, dangerSignaturePostfix))
  }

  getDangerInlineComments = async (dangerID: string): Promise<Comment[]> => {
    const username = this.repoCredentials.username
    const activities = await this.getPullRequestComments()
    const dangerIDMessage = dangerIDToString(dangerID)

    const comments = activities
      .filter(activity => activity.commentAnchor)
      .map(activity => activity.comment)
      .filter(Boolean) as BitBucketServerPRComment[]
    return new Promise<Comment[]>(resolve => {
      resolve(
        comments
          .map((i: any) => {
            return {
              id: i.id,
              ownedByDanger: i.author.name === username && i.text.includes(dangerIDMessage),
              body: i.text,
            }
          })
          .filter((i: any) => i.ownedByDanger)
      )
    })
  }

  // The last two are "optional" in the protocol, but not really optional WRT the BBSAPI
  getFileContents = async (filePath: string, repoSlug?: string, refspec?: string) => {
    const path = `${repoSlug}/` + `raw/${filePath}` + `?at=${refspec}`
    const res = await this.get(path, undefined, true)
    if (res.status === 404) {
      return ""
    }
    throwIfNotOk(res)
    return await res.text()
  }

  postBuildStatus = async (
    commitId: string,
    payload: {
      state: string
      key: string
      name: string
      url: string
      description: string
    }
  ) => {
    const res = await this.post(`rest/build-status/1.0/commits/${commitId}`, {}, payload)
    throwIfNotOk(res)
    return await res.json()
  }

  postPRComment = async (comment: string) => {
    const path = `${this.getPRBasePath()}/comments`
    const res = await this.post(path, {}, { text: comment })
    return await res.json()
  }

  postInlinePRComment = async (comment: string, line: number, type: string, filePath: string) => {
    const path = `${this.getPRBasePath()}/comments`
    const t = { add: "ADDED", normal: "CONTEXT", del: "REMOVED" }[type]

    const res = await this.post(
      path,
      {},
      {
        text: comment,
        anchor: {
          line: line,
          lineType: t,
          fileType: "TO",
          path: filePath,
        },
      }
    )
    if (res.ok) {
      return res.json()
    } else {
      throw await res.json()
    }
  }

  deleteComment = async ({ id, version }: BitBucketServerPRComment) => {
    const path = `${this.getPRBasePath()}/comments/${id}?version=${version}`
    const res = await this.delete(path)
    if (!res.ok) {
      throw new Error(`Failed to delete comment "${id}`)
    }
  }

  updateComment = async ({ id, version }: BitBucketServerPRComment, comment: string) => {
    const path = `${this.getPRBasePath()}/comments/${id}`
    const res = await this.put(
      path,
      {},
      {
        text: comment,
        version,
      }
    )
    if (res.ok) {
      return res.json()
    } else {
      throw await res.json()
    }
  }

  // API implementation

  private api = (path: string, headers: any = {}, body: any = {}, method: string, suppressErrors?: boolean) => {
    if (this.repoCredentials.username) {
      headers["Authorization"] = `Basic ${new Buffer(
        this.repoCredentials.username + ":" + this.repoCredentials.password
      ).toString("base64")}`
    }

    const url = `${this.repoCredentials.host}/${path}`
    this.d(`${method} ${url}`)
    return this.fetch(
      url,
      {
        method,
        body,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      suppressErrors
    )
  }

  get = (path: string, headers: any = {}, suppressErrors?: boolean): Promise<node_fetch.Response> =>
    this.api(path, headers, null, "GET", suppressErrors)

  post = (path: string, headers: any = {}, body: any = {}, suppressErrors?: boolean): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "POST", suppressErrors)

  put = (path: string, headers: any = {}, body: any = {}): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "PUT")

  delete = (path: string, headers: any = {}, body: any = {}): Promise<node_fetch.Response> =>
    this.api(path, headers, JSON.stringify(body), "DELETE")
}

function throwIfNotOk(res: node_fetch.Response) {
  if (!res.ok) {
    let message = `${res.status} - ${res.statusText}`
    if (res.status >= 400 && res.status < 500) {
      message += ` (Have you set DANGER_BITBUCKETSERVER_USERNAME and DANGER_BITBUCKETSERVER_PASSWORD?)`
    }
    throw new Error(message)
  }
}
