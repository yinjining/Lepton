'use strict'

import { remote } from 'electron'
import githubApi from './githubApi'
import gitlabApi from './gitlabApi'

const conf = remote.getGlobal('conf')
const logger = remote.getGlobal('logger')

let api = githubApi
if (conf) {
  if (conf.get('gitlab:enable')) {
    api = gitlabApi
  }
}

export const EXCHANGE_ACCESS_TOKEN = 'EXCHANGE_ACCESS_TOKEN'
export const GET_ALL_GISTS = 'GET_ALL_GISTS'
export const GET_ALL_GISTS_V1 = 'GET_ALL_GISTS_V1'
export const GET_SINGLE_GIST = 'GET_SINGLE_GIST'
export const GET_USER_PROFILE = 'GET_USER_PROFILE'
export const CREATE_SINGLE_GIST = 'CREATE_SINGLE_GIST'
export const EDIT_SINGLE_GIST = 'EDIT_SINGLE_GIST'
export const DELETE_SINGLE_GIST = 'DELETE_SINGLE_GIST'

export function getGitHubApi (selection) {
  switch (selection) {
    case EXCHANGE_ACCESS_TOKEN:
      return api.exchangeAccessToken
    case GET_ALL_GISTS:
      return api.getAllGistsV2
    case GET_ALL_GISTS_V1:
      return api.getAllGistsV1
    case GET_SINGLE_GIST:
      return api.getSingleGist
    case GET_USER_PROFILE:
      return api.getUserProfile
    case CREATE_SINGLE_GIST:
      return api.createSingleGist
    case EDIT_SINGLE_GIST:
      return api.editSingleGist
    case DELETE_SINGLE_GIST:
      return api.deleteSingleGist
    default:
      logger.debug('GitApi Not implemented yet.')
  }
}
