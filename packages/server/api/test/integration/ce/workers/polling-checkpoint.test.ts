import { DEDUPE_KEY_PROPERTY } from '@activepieces/pieces-framework'
import { FlowVersionState, RunEnvironment, StreamStepProgress, SubmitPayloadsRequest } from '@activepieces/shared'
import { FastifyInstance } from 'fastify'
import { storeEntryService } from '../../../../src/app/store-entry/store-entry.service'
import { createHandlers } from '../../../../src/app/workers/rpc/worker-rpc-service'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('polling checkpoint submission', () => {
    it('replays an uncommitted batch and commits the checkpoint after creating runs', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)

        const key = `flow_${flow.id}/lastPoll`
        await storeEntryService.upsert({ projectId: ctx.project.id, request: { key, value: 1000 } })
        const request: SubmitPayloadsRequest = {
            flowVersionId: flowVersion.id,
            projectId: ctx.project.id,
            payloads: [{ [DEDUPE_KEY_PROPERTY]: 'event-1', id: 'event-1' }],
            environment: RunEnvironment.TESTING,
            streamStepProgress: StreamStepProgress.NONE,
            pollingCheckpoint: { key: 'lastPoll', value: 2000 },
        }

        const upsert = vi.spyOn(storeEntryService, 'upsert').mockRejectedValueOnce(new Error('checkpoint unavailable'))
        await expect(createHandlers(app.log).submitPayloads(request)).rejects.toThrow('checkpoint unavailable')

        expect((await db.findBy('flow_run', { flowId: flow.id })).length).toBe(1)
        expect((await storeEntryService.getOne({ projectId: ctx.project.id, key }))?.value).toBe(1000)

        upsert.mockRestore()
        const replayedRuns = await createHandlers(app.log).submitPayloads(request)

        expect(replayedRuns).toHaveLength(1)
        expect((await db.findBy('flow_run', { flowId: flow.id })).length).toBe(2)
        expect((await storeEntryService.getOne({ projectId: ctx.project.id, key }))?.value).toBe(2000)
    })
})
