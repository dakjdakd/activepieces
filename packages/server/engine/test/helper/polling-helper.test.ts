import { DedupeStrategy, Polling, pollingHelper } from '@activepieces/pieces-common'
import { Store } from '@activepieces/pieces-framework'

function fakeStore(initial: Record<string, unknown> = {}): Store {
    const data: Record<string, unknown> = { ...initial }
    return {
        async put<T>(key: string, value: T): Promise<T> {
            data[key] = value
            return value
        },
        async get<T>(key: string): Promise<T | null> {
            return (data[key] as T) ?? null
        },
        async delete(key: string): Promise<void> {
            delete data[key]
        },
    }
}

const timebasedPolling: Polling<undefined, unknown> = {
    strategy: DedupeStrategy.TIMEBASED,
    items: async () => [],
}

const lastItemPolling: Polling<undefined, unknown> = {
    strategy: DedupeStrategy.LAST_ITEM,
    items: async () => [{ id: 'newest', data: {} }],
}

const enableParams = (store: Store, isRepublish?: boolean) => ({
    store,
    auth: undefined,
    propsValue: {},
    isRepublish,
})

describe('pollingHelper.onEnable checkpoint preservation', () => {
    describe('TIMEBASED', () => {
        it('preserves lastPoll on republish when a checkpoint already exists', async () => {
            const store = fakeStore({ lastPoll: 1000 })
            await pollingHelper.onEnable(timebasedPolling, enableParams(store, true))
            expect(await store.get('lastPoll')).toBe(1000)
        })

        it('initializes lastPoll on republish when none exists', async () => {
            const store = fakeStore()
            await pollingHelper.onEnable(timebasedPolling, enableParams(store, true))
            expect(await store.get<number>('lastPoll')).toBeGreaterThan(0)
        })

        it('resets lastPoll when not a republish, even if a checkpoint exists', async () => {
            const store = fakeStore({ lastPoll: 1000 })
            await pollingHelper.onEnable(timebasedPolling, enableParams(store, false))
            expect(await store.get<number>('lastPoll')).toBeGreaterThan(1000)
        })
    })

    describe('LAST_ITEM', () => {
        it('preserves lastItem on republish when a checkpoint already exists', async () => {
            const store = fakeStore({ lastItem: 'previous' })
            await pollingHelper.onEnable(lastItemPolling, enableParams(store, true))
            expect(await store.get('lastItem')).toBe('previous')
        })

        it('seeds lastItem on republish when none exists', async () => {
            const store = fakeStore()
            await pollingHelper.onEnable(lastItemPolling, enableParams(store, true))
            expect(await store.get('lastItem')).toBe('newest')
        })

        it('reseeds lastItem when not a republish, even if a checkpoint exists', async () => {
            const store = fakeStore({ lastItem: 'previous' })
            await pollingHelper.onEnable(lastItemPolling, enableParams(store, false))
            expect(await store.get('lastItem')).toBe('newest')
        })
    })
})

describe('pollingHelper.poll checkpoint delivery', () => {
    const files = {
        write: async () => '',
        upload: async () => ({ id: '', url: '' }),
    }

    it('defers the timebased checkpoint until payload submission', async () => {
        const deferPollingCheckpoint = vi.fn()
        const store = { ...fakeStore({ lastPoll: 1000 }), deferPollingCheckpoint }
        const polling: Polling<undefined, unknown> = {
            strategy: DedupeStrategy.TIMEBASED,
            items: async () => [{ epochMilliSeconds: 2000, data: { id: 'event-1' } }],
        }

        const output = await pollingHelper.poll(polling, { store, auth: undefined, propsValue: {}, files })

        expect(output).toEqual([{ id: 'event-1' }])
        expect(deferPollingCheckpoint).toHaveBeenCalledWith('lastPoll', 2000)
        expect(await store.get('lastPoll')).toBe(1000)
    })

    it('does not submit an unchanged timebased checkpoint', async () => {
        const deferPollingCheckpoint = vi.fn()
        const store = { ...fakeStore({ lastPoll: 1000 }), deferPollingCheckpoint }

        const output = await pollingHelper.poll(timebasedPolling, { store, auth: undefined, propsValue: {}, files })

        expect(output).toEqual([])
        expect(deferPollingCheckpoint).not.toHaveBeenCalled()
    })

    it('persists a checkpoint when no submission context is available', async () => {
        const store = fakeStore({ lastPoll: 1000 })
        const polling: Polling<undefined, unknown> = {
            strategy: DedupeStrategy.TIMEBASED,
            items: async () => [{ epochMilliSeconds: 2000, data: { id: 'event-1' } }],
        }

        await pollingHelper.poll(polling, { store, auth: undefined, propsValue: {}, files })

        expect(await store.get('lastPoll')).toBe(2000)
    })

    it('defers the last-item checkpoint until payload submission', async () => {
        const deferPollingCheckpoint = vi.fn()
        const store = { ...fakeStore({ lastItem: 'previous' }), deferPollingCheckpoint }
        const polling: Polling<undefined, unknown> = {
            strategy: DedupeStrategy.LAST_ITEM,
            items: async () => [
                { id: 'newest', data: { id: 'event-1' } },
                { id: 'previous', data: { id: 'event-0' } },
            ],
        }

        const output = await pollingHelper.poll(polling, { store, auth: undefined, propsValue: {}, files })

        expect(output).toEqual([{ id: 'event-1' }])
        expect(deferPollingCheckpoint).toHaveBeenCalledWith('lastItem', 'newest')
        expect(await store.get('lastItem')).toBe('previous')
    })
})
