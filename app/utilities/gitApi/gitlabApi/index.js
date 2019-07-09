'use strict'

import { Promise } from 'bluebird'
import { remote } from 'electron'
// import Notifier from '../../notifier'
// import ProxyAgent from 'proxy-agent'
import ReqPromise from 'request-promise'
// import Request from 'request'
import md5 from 'md5'

const TAG = '[Gitlab REST] '
const kTimeoutUnit = 10 * 1000 // ms
const logger = remote.getGlobal('logger')
const conf = remote.getGlobal('conf')
const userAgent = 'hackjutsu-lepton-app'
let hostApi = ''
let group = ''
let name = ''

let proxyAgent = null
if (conf) {
  if (conf.get('gitlab:enable')) {
    const gitlabHost = conf.get('gitlab:host')
    hostApi = `${gitlabHost}/api/v4`
    group = conf.get('gitlab:group')
    name = conf.get('gitlab:name')
  }
}

function getUserProfile (token) {
  logger.debug(TAG + 'Getting user profile with token ' + token)

  const result = {}
  return ReqPromise({
    uri: `http://${hostApi}/user`,
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
    result.login = profile.username
    return getProjectId(token, group, name)
  }).then((projectId) => {
    result.projectId = projectId
    return result
  })
}

function getProjectId (token, group, name) {
  logger.debug(TAG + 'Getting project id with token ' + group + '；' + name)

  return ReqPromise({
    uri: `http://${hostApi}/projects`,
    agent: proxyAgent,
    headers: {
      'User-Agent': userAgent
    },
    method: 'GET',
    qs: {
      private_token: token,
      search: name
    },
    json: true, // Automatically parses the JSON string in the response
    timeout: 2 * kTimeoutUnit
  }).then(res => {
    console.log('get project id', res)

    return new Promise((resolve, reject) => {
      if (group === '' || name === '') {
        reject(new Error('group or name is null'))
        return
      }

      const pathWithNamespace = group + '/' + name
      let projectId = ''
      for (let i = 0; i < res.length; i++) {
        let project = res[i]
        if (project['path_with_namespace'] === pathWithNamespace) {
          projectId = project.id
          break
        }
      }

      if (projectId === '') {
        reject(new Error('don\'t get projectId'))
      } else {
        resolve(projectId)
      }
    })
  })
}

function getSingleGist (token, gistId, oldGist) {
  logger.debug(TAG + `Getting single gist ${gistId} with token ${token}`)

  const requests = []
  for (let filename in oldGist.brief.files) {
    requests.push(requestSnippetContent(oldGist.brief.files[filename], token, oldGist.brief.project_id))
  }
  console.log('getSingleGist', requests, oldGist)

  return Promise.all(requests)
    .then(() => {
      return oldGist.brief
    })
}

function requestSnippetContent (snippet, token, projectId) {
  logger.debug(TAG + `Requesting snippet content ${snippet.id} with token ${token}`)
  const SINGLE_GIST_URI = `http://${hostApi}/projects/${projectId}/snippets/${snippet.id}/raw`
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
function getAllGistsV2 (token, userId, projectId) {
  logger.debug(TAG + `Getting all gists of ${projectId} with token ${token}`)
  const snippetsList = []
  return requestGists(token, 1, snippetsList, projectId)
    .then(res => {
      // console.log('The res is', res)
      // const matches = res.headers['link'].match(/page=[0-9]*/g)
      // const maxPage = matches[matches.length - 1].substring('page='.length)
      const maxPage = res.headers['x-total-pages']
      logger.debug(TAG + `The max page number for gist is ${maxPage}`)

      const requests = []
      for (let i = 2; i <= maxPage; ++i) { requests.push(requestGists(token, i, snippetsList, projectId)) }
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
        snippet['language'] = judgeLanguage(snippet['file_name'])
        snippet['filename'] = snippet['file_name']

        gist.description = snippet['description']
        gist.id = snippet['title']
        gist['updated_at'] = snippet['updated_at']
        gist['created_at'] = snippet['created_at']
        gist['html_url'] = snippet['web_url']
        gist['user'] = snippet['author']['username']
        gist['project_id'] = snippet['project_id']
      }

      console.log('gistList=', gistList)
      // 做归类处理
      return gistList
    })
    .catch((err) => {
      logger.debug(TAG + `[V2] Something wrong happens ${err}. Falling back to [V1]...`)
      // return getAllGistsV1(token, userId)
    })
}

function requestGists (token, page, gistList, projectId) {
  logger.debug(TAG + 'Requesting gists with page ' + page)
  return ReqPromise(makeOptionForGetAllGists(token, page, projectId))
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

// const EMPTY_PAGE_ERROR_MESSAGE = 'page empty (Not an error)'
// function getAllGistsV1 (token, userId) {
//   logger.debug(TAG + `[V1] Getting all gists of ${userId} with token ${token}`)
//   let gistList = []
//   return new Promise((resolve, reject) => {
//     const maxPageNumber = 100
//     let funcs = Promise.resolve(
//       makeRangeArr(1, maxPageNumber).map(
//         (n) => makeRequestForGetAllGists(makeOptionForGetAllGists(token, userId, n))))
//
//     funcs.mapSeries(iterator)
//       .catch(err => {
//         if (err !== EMPTY_PAGE_ERROR_MESSAGE) {
//           logger.error(err)
//           Notifier('Sync failed', 'Please check your network condition. 05')
//         }
//       })
//       .finally(() => {
//         resolve(gistList)
//       })
//   })
//
//   function iterator (f) {
//     return f()
//   }
//
//   function makeRequestForGetAllGists (option) {
//     return () => {
//       return new Promise((resolve, reject) => {
//         Request(option, (error, response, body) => {
//           logger.debug('The gist number on this page is ' + body.length)
//           if (error) {
//             reject(error)
//           } else if (body.length === 0) {
//             reject(EMPTY_PAGE_ERROR_MESSAGE)
//           } else {
//             for (let key in body) {
//               if (body.hasOwnProperty(key)) {
//                 gistList.push(body[key])
//               }
//             }
//             resolve(body)
//           }
//         })
//       })
//     }
//   }
// }
//
// function makeRangeArr (start, end) {
//   let result = []
//   for (let i = start; i <= end; i++) result.push(i)
//   return result
// }

const GISTS_PER_PAGE = 100
function makeOptionForGetAllGists (token, page, projectId) {
  return {
    uri: `http://${hostApi}/projects/${projectId}/snippets`,
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

function createSingleGist (token, description, files, isPublic, projectId) {
  logger.debug(TAG + 'Creating single gist')

  // 通过description，生成其md5值，当作title
  const title = md5(description)

  const requests = []
  for (let filename in files) {
    requests.push(createSingleSnippet(token, title, description, filename, files[filename].content, false, projectId))
  }
  return Promise.all(requests)
    .then((res) => {
      console.log('create res', res)
      // 转换所有的结果
      const gist = {}

      let isInit = false
      gist.files = {}
      for (let i = 0; i < res.length; i++) {
        let snippet = res[i]

        if (!isInit) {
          isInit = true
          gist.description = snippet['description']
          gist.id = snippet['title']
          gist['updated_at'] = snippet['updated_at']
          gist['created_at'] = snippet['created_at']
          gist['html_url'] = snippet['web_url']
          gist['user'] = snippet['author']['username']
          gist['project_id'] = snippet['project_id']
        }

        gist.files[snippet['file_name']] = snippet
        snippet['language'] = judgeLanguage(snippet['file_name'])
        snippet['filename'] = snippet['file_name']
      }

      console.log('createSingleGist', gist)
      return gist
    })
}

function createSingleSnippet (token, title, description, filename, filecontent, isPublic, projectId) {
  console.log('createSingleSnippet', title, description, filename, isPublic)

  logger.debug(TAG + 'Creating single snippet' + filename)
  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'POST',
    uri: `http://${hostApi}/projects/${projectId}/snippets`,
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
    return requestSnippetContent(snippet, token, projectId)
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
        requests.push(deleteSingleSnippet(token, gist.brief.files[filename].id, gist.brief.project_id))
      } else {
        // 更新
        requests.push(updateSingleSnippet(token, file.id, file.title, updatedDescription, filename, updatedFiles[filename].content, gist.brief.project_id))
      }
    } else {
      // 创建
      requests.push(createSingleSnippet(token, gist.brief.id, updatedDescription, filename, updatedFiles[filename].content, false, gist.brief.project_id))
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
          gist['html_url'] = snippet['web_url']
          gist['user'] = snippet['author']['username']
          gist['project_id'] = snippet['project_id']
        }

        gist.files[snippet['file_name']] = snippet
        snippet['language'] = judgeLanguage(snippet['file_name'])
        snippet['filename'] = snippet['file_name']
      }

      console.log('editSingleGist', gist)
      return gist
    })
}

function judgeLanguage (filename) {
  // 获取最后一个.的位置
  let index = filename.lastIndexOf('.')
  // 获取后缀
  let ext = filename.substr(index + 1)
  switch (ext) {
    case 'java':
      return 'java'
    case 'kt':
      return 'kotlin'
    case 'json':
      return 'json'
    case 'js':
      return 'javascript'
    case 'html':
      return 'html'
    case 'xml':
      return 'xml'
    case 'css':
      return 'css'
    case 'm':
      return 'Object-C'
    case 'c':
      return 'c'
    case 'mm':
      return 'c++'
    case 'swift':
      return 'swift'	
    case 'h-m':
      return 'Object-C'
    case 'h-c':
       return 'c'
    default:
      return 'java'
  }
}

function updateSingleSnippet (token, snippetId, title, description, filename, filecontent, projectId) {
  console.log('updateSingleSnippet', title, description, filename)
  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'PUT',
    uri: `http://${hostApi}/projects/${projectId}/snippets/${snippetId}`,
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
    return requestSnippetContent(snippet, token, projectId)
  })
}

function deleteSingleGist (token, gistId, gist) {
  logger.debug(TAG + 'Deleting single gist ' + gistId)

  const requests = []
  for (let filename in gist.brief.files) {
    requests.push(deleteSingleSnippet(token, gist.brief.files[filename].id, gist.brief.project_id))
  }
  return Promise.all(requests)
}

function deleteSingleSnippet (token, snippetId, projectId) {
  console.log('deleteSingleSnippet', snippetId)

  return ReqPromise({
    headers: {
      'User-Agent': userAgent,
    },
    method: 'DELETE',
    uri: `http://${hostApi}/projects/${projectId}/snippets/${snippetId}`,
    agent: proxyAgent,
    qs: {
      private_token: token
    },
    json: true,
    timeout: 2 * kTimeoutUnit
  })
}

export default { getAllGistsV2, getSingleGist, getUserProfile, createSingleGist, editSingleGist, deleteSingleGist }
