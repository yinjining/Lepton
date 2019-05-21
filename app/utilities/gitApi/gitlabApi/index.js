'use strict'

import { Promise } from 'bluebird'
import { remote } from 'electron'
import Notifier from '../../notifier'
// import ProxyAgent from 'proxy-agent'
import ReqPromise from 'request-promise'
import Request from 'request'
import md5 from 'md5'

const TAG = '[Gitlab REST] '
const kTimeoutUnit = 10 * 1000 // ms
const logger = remote.getGlobal('logger')
const conf = remote.getGlobal('conf')
const userAgent = 'hackjutsu-lepton-app'
let hostApi = 'igit.58corp.com'

let proxyAgent = null
if (conf) {
  // 暂时不支持proxy
  // if (conf.get('proxy:enable')) {
  //   const proxyUri = conf.get('proxy:address')
  //   proxyAgent = new ProxyAgent(proxyUri)
  //   logger.info('[.leptonrc] Use proxy', proxyUri)
  // }
  if (conf.get('gitlab:enable')) {
    const gitlabHost = conf.get('gitlab:host')
    hostApi = `${gitlabHost}/api/v4`
  }
}

function exchangeAccessToken (clientId, clientSecret, authCode) {
  logger.debug(TAG + 'Exchanging authCode with access token')
  return ReqPromise({
    method: 'POST',
    uri: 'https://github.com/login/oauth/access_token',
    agent: proxyAgent,
    form: {
      'client_id': clientId,
      'client_secret': clientSecret,
      'code': authCode,
    },
    json: true,
    timeout: 2 * kTimeoutUnit
  })
}

function getUserProfile (token) {
  logger.debug(TAG + 'Getting user profile with token ' + token)
  const USER_PROFILE_URI = `http://${hostApi}/user`
  return ReqPromise({
    uri: USER_PROFILE_URI,
    agent: proxyAgent,
    headers: {
      'User-Agent': userAgent,
    },
    method: 'GET',
    qs: {
      private_token: token
    },
    json: true, // Automatically parses the JSON string in the response
    timeout: 2 * kTimeoutUnit
  }).then((profile) => {
    logger.debug('-----> from gitlab api to github api ' + JSON.stringify(profile))
    return { login: profile.username, id: profile.id }
  })
}

function getSingleGist (token, gistId, oldGist) {
  logger.debug(TAG + `Getting single gist ${gistId} with token ${token}`)

  const requests = []
  for (let filename in oldGist.brief.files) {
    requests.push(requestSnippetContent(oldGist.brief.files[filename], token))
  }
  console.log('getSingleGist', requests, oldGist)

  return Promise.all(requests)
    .then(() => {
      return oldGist.brief
    })
}

function requestSnippetContent (snippet, token) {
  // http://igit.58corp.com/api/v4/projects/29334/snippets/50/raw?private_token=xxxx
  logger.debug(TAG + `Requesting snippet content ${snippet.id} with token ${token}`)
  const SINGLE_GIST_URI = `http://${hostApi}/projects/29334/snippets/${snippet.id}/raw`
  return ReqPromise({
    uri: SINGLE_GIST_URI,
    agent: proxyAgent,
    headers: {
      'User-Agent': userAgent
    },
    method: 'GET',
    qs: {
      private_token: token
    },
    json: true, // Automatically parses the JSON string in the response
    timeout: 2 * kTimeoutUnit
  }).then(res => {
    snippet.content = res
    return snippet
  })
}

/**
 * 请求gitlab的Snippets数据，并进行合并归类
 * @param token
 * @param userId
 * @returns {*|*|*|*|Promise<T | never>}
 */
function getAllGistsV2 (token, userId) {
  logger.debug(TAG + `Getting all gists of ${userId} with token ${token}`)
  const snippetsList = []
  return requestGists(token, userId, 1, snippetsList)
    .then(res => {
      // console.log('The res is', res)
      // const matches = res.headers['link'].match(/page=[0-9]*/g)
      // const maxPage = matches[matches.length - 1].substring('page='.length)
      const maxPage = res.headers['x-total-pages']
      logger.debug(TAG + `The max page number for gist is ${maxPage}`)

      const requests = []
      for (let i = 2; i <= maxPage; ++i) { requests.push(requestGists(token, userId, i, snippetsList)) }
      return Promise.all(requests)
        .then(() => {
          return snippetsList.sort((g1, g2) => g2.title.localeCompare(g1.title))
        })
    })
    .then(() => {
      let gistList = []
      let map = {}

      for (let i = 0; i < snippetsList.length; i++) {
        let snippet = snippetsList[i]
        let gist = map[snippet.title]

        if (!gist) {
          gist = {}
          map[snippet.title] = gist
          gistList.push(gist)
        }

        gist.files = gist.files || {}
        gist.files[snippet['file_name']] = snippet
        snippet['language'] = 'java'
        snippet['filename'] = snippet['file_name']

        gist.description = snippet['description']
        gist.id = snippet['title']
        gist['updated_at'] = snippet['updated_at']
        gist['created_at'] = snippet['created_at']
      }

      console.log('gistList=', gistList)
      // 做归类处理
      return gistList
    })
    .catch(err => {
      logger.debug(TAG + `[V2] Something wrong happens ${err}. Falling back to [V1]...`)
      return getAllGistsV1(token, userId)
    })
}

function requestGists (token, userId, page, gistList) {
  logger.debug(TAG + 'Requesting gists with page ' + page)
  return ReqPromise(makeOptionForGetAllGists(token, userId, page))
    .catch(err => {
      logger.error(err)
    })
    .then(res => {
      parseBody(res.body, gistList)
      return res
    })
}

function parseBody (res, gistList) {
  for (let key in res) { if (res.hasOwnProperty(key)) gistList.push(res[key]) }
}

const EMPTY_PAGE_ERROR_MESSAGE = 'page empty (Not an error)'
function getAllGistsV1 (token, userId) {
  logger.debug(TAG + `[V1] Getting all gists of ${userId} with token ${token}`)
  let gistList = []
  return new Promise((resolve, reject) => {
    const maxPageNumber = 100
    let funcs = Promise.resolve(
      makeRangeArr(1, maxPageNumber).map(
        (n) => makeRequestForGetAllGists(makeOptionForGetAllGists(token, userId, n))))

    funcs.mapSeries(iterator)
      .catch(err => {
        if (err !== EMPTY_PAGE_ERROR_MESSAGE) {
          logger.error(err)
          Notifier('Sync failed', 'Please check your network condition. 05')
        }
      })
      .finally(() => {
        resolve(gistList)
      })
  })

  function iterator (f) {
    return f()
  }

  function makeRequestForGetAllGists (option) {
    return () => {
      return new Promise((resolve, reject) => {
        Request(option, (error, response, body) => {
          logger.debug('The gist number on this page is ' + body.length)
          if (error) {
            reject(error)
          } else if (body.length === 0) {
            reject(EMPTY_PAGE_ERROR_MESSAGE)
          } else {
            for (let key in body) {
              if (body.hasOwnProperty(key)) {
                gistList.push(body[key])
              }
            }
            resolve(body)
          }
        })
      })
    }
  }
}

function makeRangeArr (start, end) {
  let result = []
  for (let i = start; i <= end; i++) result.push(i)
  return result
}

const GISTS_PER_PAGE = 100
function makeOptionForGetAllGists (token, userId, page) {
  // 29334是WubaSnippets项目的project_id
  // http://igit.58corp.com/api/v4/projects/29334/snippets?private_token=xxxxx
  return {
    uri: `http://${hostApi}/projects/29334/snippets`,
    agent: proxyAgent,
    headers: {
      'User-Agent': userAgent,
    },
    method: 'GET',
    qs: {
      private_token: token,
      per_page: GISTS_PER_PAGE,
      page: page
    },
    json: true,
    timeout: 2 * kTimeoutUnit,
    resolveWithFullResponse: true
  }
}

function createSingleGist (token, description, files, isPublic) {
  logger.debug(TAG + 'Creating single gist')

  // 通过description，生成其md5值，当作title
  const title = md5(description)

  const requests = []
  for (let filename in files) {
    requests.push(createSingleSnippet(token, title, description, filename, files[filename].content, isPublic))
  }
  return Promise.all(requests)
    .then((res) => {
      console.log('create res', res)
      // 转换所有的结果
      const gist = {}

      gist.description = res[0]['description']
      gist.id = res[0]['title']
      gist['updated_at'] = res[0]['updated_at']
      gist['created_at'] = res[0]['created_at']

      gist.files = {}
      for (let i = 0; i < res.length; i++) {
        let snippet = res[i]
        gist.files[snippet['file_name']] = snippet
        snippet['language'] = 'java'
        snippet['filename'] = snippet['file_name']
      }

      console.log('createSingleGist', gist)
      return gist
    })
}

function createSingleSnippet (token, title, description, filename, filecontent, isPublic) {
  console.log('createSingleSnippet', title, description, filename, isPublic)

  logger.debug(TAG + 'Creating single snippet' + filename)
  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'POST',
    uri: `http://${hostApi}/projects/29334/snippets`,
    agent: proxyAgent,
    qs: {
      private_token: token
    },
    body: {
      title: title,
      description: description,
      visibility: isPublic ? 'public' : 'private',
      file_name: filename,
      code: filecontent
    },
    json: true,
    timeout: 2 * kTimeoutUnit
  }).then((snippet) => {
    return requestSnippetContent(snippet, token)
  })
}

function editSingleGist (token, gistId, updatedDescription, updatedFiles, gist) {
  logger.debug(TAG + 'Editing single gist ' + gistId)

  console.log('editSingleGist', updatedFiles, gist)

  const requests = []
  for (let filename in updatedFiles) {
    let file = gist.brief.files[filename]

    if (file) {
      if (updatedFiles[filename] == null) {
        // 删除
        requests.push(deleteSingleSnippet(token, gist.brief.files[filename].id))
      } else {
        // 更新
        requests.push(updateSingleSnippet(token, file.id, file.title, updatedDescription, filename, updatedFiles[filename].content))
      }
    } else {
      // 创建
      requests.push(createSingleSnippet(token, gist.brief.id, updatedDescription, filename, updatedFiles[filename].content, false))
    }
  }

  return Promise.all(requests)
    .then((res) => {
      console.log('editor res', res)
      // 转换所有的结果
      const gist = {}

      let isInit = false
      gist.files = {}
      for (let i = 0; i < res.length; i++) {
        let snippet = res[i]
        if (!snippet) {
          continue
        }
        if (!isInit) {
          isInit = true
          gist.description = snippet['description']
          gist.id = snippet['title']
          gist['updated_at'] = snippet['updated_at']
          gist['created_at'] = snippet['created_at']
        }

        gist.files[snippet['file_name']] = snippet
        snippet['language'] = 'java'
        snippet['filename'] = snippet['file_name']
      }

      console.log('editSingleGist', gist)
      return gist
    })
}

function updateSingleSnippet (token, snippetId, title, description, filename, filecontent) {
  console.log('updateSingleSnippet', title, description, filename)
  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'PUT',
    uri: `http://${hostApi}/projects/29334/snippets/${snippetId}`,
    agent: proxyAgent,
    qs: {
      private_token: token
    },
    body: {
      title: title,
      description: description,
      file_name: filename,
      code: filecontent
    },
    json: true,
    timeout: 2 * kTimeoutUnit
  }).then((snippet) => {
    return requestSnippetContent(snippet, token)
  })
}

function deleteSingleGist (token, gistId, gist) {
  logger.debug(TAG + 'Deleting single gist ' + gistId)

  const requests = []
  for (let filename in gist.brief.files) {
    requests.push(deleteSingleSnippet(token, gist.brief.files[filename].id))
  }
  return Promise.all(requests)
}

function deleteSingleSnippet (token, snippetId) {
  console.log('deleteSingleSnippet', snippetId)

  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'DELETE',
    uri: `http://${hostApi}/projects/29334/snippets/${snippetId}`,
    agent: proxyAgent,
    qs: {
      private_token: token
    },
    json: true,
    timeout: 2 * kTimeoutUnit
  })
}

export default { exchangeAccessToken, getAllGistsV2, getAllGistsV1, getSingleGist, getUserProfile, createSingleGist, editSingleGist, deleteSingleGist }
