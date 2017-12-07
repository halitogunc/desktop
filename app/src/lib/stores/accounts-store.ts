import { Emitter, Disposable } from 'event-kit'
import { IDataStore, ISecureStore } from './stores'
import { getKeyForAccount } from '../auth'
import { Account } from '../../models/account'
import { API, EmailVisibility } from '../api'
import { getAvatarWithEnterpriseFallback } from '../gravatar'
import { fatalError } from '../fatal-error'

/** The data-only interface for storage. */
interface IEmail {
  readonly email: string
  /**
   * Represents whether GitHub has confirmed the user has access to this
   * email address. New users require a verified email address before
   * they can sign into GitHub Desktop.
   */
  readonly verified: boolean
  /**
   * Flag for the user's preferred email address. Other email addresses
   * are provided for associating commit authors with the one GitHub account.
   */
  readonly primary: boolean

  /** The way in which the email is visible. */
  readonly visibility: EmailVisibility
}

/** The data-only interface for storage. */
interface IAccount {
  readonly token: string
  readonly login: string
  readonly endpoint: string
  readonly emails: ReadonlyArray<IEmail>
  readonly avatarURL: string
  readonly id: number
  readonly name: string
}

/** The store for logged in accounts. */
export class AccountsStore {
  private dataStore: IDataStore
  private secureStore: ISecureStore

  private accounts: ReadonlyArray<Account> = []

  /** A promise that will resolve when the accounts have been loaded. */
  private loadingPromise: Promise<void>

  private readonly emitter = new Emitter()

  public constructor(dataStore: IDataStore, secureStore: ISecureStore) {
    this.dataStore = dataStore
    this.secureStore = secureStore
    this.loadingPromise = this.loadFromStore()
  }

  private emitUpdate() {
    this.emitter.emit('did-update', {})
  }

  private emitError(error: Error) {
    this.emitter.emit('did-error', error)
  }

  /** Register a function to be called when the store updates. */
  public onDidUpdate(fn: () => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  /** Register a function to be called when an error occurs. */
  public onDidError(fn: (error: Error) => void): Disposable {
    return this.emitter.on('did-error', fn)
  }

  /**
   * Get the list of accounts in the cache.
   */
  public async getAll(): Promise<ReadonlyArray<Account>> {
    await this.loadingPromise

    return this.accounts.slice()
  }

  /**
   * Add the account to the store.
   */
  public async addAccount(account: Account): Promise<void> {
    await this.loadingPromise

    let updated = account
    try {
      updated = await updatedAccount(account)
    } catch (e) {
      log.warn(`Failed to fetch user ${account.login}`, e)
    }

    try {
      await this.secureStore.setItem(
        getKeyForAccount(updated),
        updated.login,
        updated.token
      )
    } catch (e) {
      log.error(`Error adding account '${account.login}'`, e)
      this.emitError(e)
      return
    }

    this.accounts = this.accounts.concat(updated)

    this.save()
  }

  /** Refresh all accounts by fetching their latest info from the API. */
  public async refresh(): Promise<void> {
    const updatedAccounts = new Array<Account>()
    for (const account of this.accounts) {
      try {
        const updated = await updatedAccount(account)
        updatedAccounts.push(updated)
      } catch (e) {
        log.warn(`Error refreshing account '${account.login}'`, e)
      }
    }

    this.accounts = updatedAccounts
    this.emitUpdate()
  }

  /**
   * Remove the account from the store.
   */
  public async removeAccount(account: Account): Promise<void> {
    await this.loadingPromise

    try {
      await this.secureStore.deleteItem(
        getKeyForAccount(account),
        account.login
      )
    } catch (e) {
      log.error(`Error removing account '${account.login}'`, e)
      this.emitError(e)
      return
    }

    this.accounts = this.accounts.filter(a => a.id !== account.id)

    this.save()
  }

  /**
   * Load the users into memory from storage.
   */
  private async loadFromStore(): Promise<void> {
    const raw = this.dataStore.getItem('users')
    if (!raw || !raw.length) {
      return
    }

    const rawAccounts: ReadonlyArray<IAccount> = JSON.parse(raw)
    const accountsWithTokens = []
    for (const account of rawAccounts) {
      const accountWithoutToken = new Account(
        account.login,
        account.endpoint,
        '',
        account.emails,
        account.avatarURL,
        account.id,
        account.name
      )

      const key = getKeyForAccount(accountWithoutToken)
      try {
        const token = await this.secureStore.getItem(key, account.login)
        accountsWithTokens.push(accountWithoutToken.withToken(token || ''))
      } catch (e) {
        log.error(`Error getting token for '${key}'. Skipping.`, e)

        this.emitError(e)
      }
    }

    this.accounts = accountsWithTokens
    this.emitUpdate()
  }

  private save() {
    const usersWithoutTokens = this.accounts.map(account =>
      account.withToken('')
    )
    this.dataStore.setItem('users', JSON.stringify(usersWithoutTokens))

    this.emitUpdate()
  }
}

async function updatedAccount(account: Account): Promise<Account> {
  if (!account.token) {
    return fatalError(
      `Cannot update an account which doesn't have a token: ${account}`
    )
  }

  const api = API.fromAccount(account)
  const user = await api.fetchAccount()
  const emails = await api.fetchEmails()

  const defaultEmail = emails[0].email || ''
  const avatarURL = getAvatarWithEnterpriseFallback(
    user.avatar_url,
    defaultEmail,
    account.endpoint
  )

  return new Account(
    account.login,
    account.endpoint,
    account.token,
    emails,
    avatarURL,
    user.id,
    user.name
  )
}
