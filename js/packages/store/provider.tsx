import React from 'react'
import * as middleware from '@berty-tech/grpc-bridge/middleware'
import { messenger as messengerpb } from '@berty-tech/api/index.js'
import { grpcweb as rpcWeb, bridge as rpcBridge } from '@berty-tech/grpc-bridge/rpc'
import { Service, EOF } from '@berty-tech/grpc-bridge'
import ExternalTransport from './externalTransport'
import cloneDeep from 'lodash/cloneDeep'
import GoBridge, { GoLogLevel } from '@berty-tech/go-bridge'
import MsgrContext, { initialState } from './context'
import pickBy from 'lodash/pickBy'
import mapValues from 'lodash/mapValues'
import { EventEmitter } from 'events'

const T = messengerpb.StreamEvent.Type

const reducer = (oldState: any, action: { type: string; payload?: any }) => {
	const state = cloneDeep(oldState) // TODO: optimize rerenders
	state.client = oldState.client
	console.log('reducing', action)
	switch (action.type) {
		case 'SET_STREAM_ERROR':
			state.streamError = action.payload.error
			break
		case 'CLEAR':
			return { ...initialState, embedded: oldState.embedded, daemonAddress: oldState.daemonAddress }
		case 'SET_CLIENT':
			state.client = action.payload.client
			break
		case 'DELETE_STATE_UPDATED':
			state.deleteState = action.payload.state
			break
		case T.TypeConversationUpdated:
			const conv = action.payload.conversation
			state.conversations[conv.publicKey] = conv
			break
		case T.TypeAccountUpdated:
			const acc = action.payload.account
			state.account = acc
			break
		case T.TypeContactUpdated:
			const contact = action.payload.contact
			state.contacts[contact.publicKey] = contact
			break
		case T.TypeMemberUpdated:
			const member = action.payload.member
			if (!state.members[member.conversationPublicKey]) {
				state.members[member.conversationPublicKey] = {}
			}
			state.members[member.conversationPublicKey][member.publicKey] = member
			break
		case T.TypeInteractionDeleted:
			delete state.interactions[action.payload.cid]
			break
		case T.TypeListEnd:
			state.listDone = true
			break
		case T.TypeInteractionUpdated:
			try {
				const inte = action.payload.interaction
				const gpk = inte.conversationPublicKey
				if (!state.interactions[gpk]) {
					state.interactions[gpk] = {}
				}
				const typeName = Object.keys(messengerpb.AppMessage.Type).find(
					(name) => messengerpb.AppMessage.Type[name] === inte.type,
				)
				const name = typeName?.substr('Type'.length)
				const pbobj = messengerpb.AppMessage[name]
				if (!pbobj) {
					throw new Error('failed to find a protobuf object matching the event type')
				}
				inte.name = name
				inte.payload = pbobj.decode(inte.payload).toJSON()
				console.log('jsoned payload', inte.payload)
				console.log('received inte', inte)
				if (inte.type === messengerpb.AppMessage.Type.TypeAcknowledge) {
					if (state.interactions[gpk][inte.payload.target]) {
						state.interactions[gpk][inte.payload.target].acknowledged = true
						break
					}
				}
				state.interactions[gpk][inte.cid] = inte
			} catch (e) {
				console.warn('failed to reduce interaction', e)
				return oldState
			}
			break
		case 'ADD_FAKE_DATA':
			state.conversations = { ...state.conversations, ...action.payload.conversations }
			state.contacts = { ...state.contacts, ...action.payload.contacts }
			for (const inte of action.payload.interactions || []) {
				if (!state.interactions[inte.conversationPublicKey]) {
					state.interactions[inte.conversationPublicKey] = {}
				}
				state.interactions[inte.conversationPublicKey][inte.cid] = inte
			}
			for (const [key, members] of Object.entries(action.payload.members || {})) {
				state.members[key] = {
					...(state.members[key] || {}),
					...members,
				}
			}
			break
		case 'DELETE_FAKE_DATA':
			state.conversations = pickBy(state.conversations, (conv) => !conv.fake)
			state.contacts = pickBy(state.contacts, (contact) => !contact.fake)
			state.interactions = pickBy(
				mapValues(state.interactions, (intes) => pickBy(intes, (inte) => !inte.fake)),
				(intes) => intes.length > 0,
			)
			state.members = pickBy(
				mapValues(state.members, (members) => pickBy(members, (member) => !member.fake)),
				(members) => members.length > 0,
			)
			break
		case 'SET_DAEMON_ADDRESS':
			state.daemonAddress = action.payload.value
			break
		case 'CONVS_CLOSED':
			state.convsClosed = true
			break
		default:
			console.warn('Unknown action type', action.type)
	}
	// console.log('new global state', state)
	return state
}

export const MsgrProvider: React.FC<any> = ({ children, daemonAddress, embedded }) => {
	const [state, dispatch] = React.useReducer(reducer, { ...initialState, daemonAddress, embedded })
	const [restartCount, setRestartCount] = React.useState(0)
	const [nodeStarted, setNodeStarted] = React.useState(false)
	const [eventEmitter] = React.useState(new EventEmitter())

	const restart = React.useCallback(() => {
		setNodeStarted(false)
		dispatch({ type: 'CLEAR' })
		setRestartCount(restartCount + 1)
	}, [restartCount])

	const addNotificationListener = React.useCallback(
		(cb) => {
			eventEmitter.addListener('notification', cb)
		},
		[eventEmitter],
	)

	const removeNotificationListener = React.useCallback(
		(cb) => {
			eventEmitter.removeListener('notification', cb)
		},
		[eventEmitter],
	)

	const deleteAccount = React.useCallback(async () => {
		if (!embedded) {
			return
		}
		dispatch({ type: 'DELETE_STATE_UPDATED', payload: { state: 'STOPPING_DAEMON' } })
		await GoBridge.stopProtocol()
		dispatch({ type: 'DELETE_STATE_UPDATED', payload: { state: 'CLEARING_STORAGE' } })
		await GoBridge.clearStorage()
		dispatch({ type: 'DELETE_STATE_UPDATED', payload: { state: 'DONE' } })
	}, [embedded])

	React.useEffect(() => {
		if (state.deleteState === 'DONE') {
			restart()
		}
	}, [restart, state.deleteState])

	React.useEffect(() => {
		if (!embedded) {
			setNodeStarted(true)
			return
		}
		console.log('starting daemon')
		GoBridge.startProtocol({
			persistence: true,
			tracing: true,
			logFilters: 'info,warn:bty,bty.* error+:*',
		})
			.then(() => {
				setNodeStarted(true)
			})
			.catch((err) =>
				dispatch({
					type: 'SET_STREAM_ERROR',
					payload: { error: new Error(`Failed to start node: ${err}`) },
				}),
			)
		return () => {
			GoBridge.stopProtocol()
		}
	}, [embedded, restartCount])

	React.useEffect(() => {
		if (embedded && !nodeStarted) {
			return
		}

		console.log('starting stream')

		const messengerMiddlewares = middleware.chain(
			__DEV__ ? middleware.logger.create('MESSENGER') : null,
		)

		let rpc
		if (embedded) {
			rpc = rpcBridge
		} else {
			const opts = {
				transport: ExternalTransport(),
				host: state.daemonAddress,
			}
			rpc = rpcWeb(opts)
		}

		const messengerClient = Service(messengerpb.MessengerService, rpc, messengerMiddlewares)

		dispatch({ type: 'CLEAR' })
		dispatch({ type: 'SET_CLIENT', payload: { client: messengerClient } })

		let precancel = false
		let cancel = () => {
			precancel = true
		}
		messengerClient
			.eventStream({})
			.then(async (stream) => {
				if (precancel) {
					return
				}
				stream.onMessage((msg, err) => {
					if (err) {
						console.warn('events stream onMessage error:', err)
						dispatch({ type: 'SET_STREAM_ERROR', payload: { error: err } })
						return
					}
					const evt = msg && msg.event
					if (!evt) {
						console.warn('received empty event')
						return
					}
					const enumName = Object.keys(messengerpb.StreamEvent.Type).find(
						(name) => messengerpb.StreamEvent.Type[name] === evt.type,
					)
					const payloadName = enumName.substr('Type'.length)
					const pbobj = messengerpb.StreamEvent[payloadName]
					if (!pbobj) {
						console.warn('failed to find a protobuf object matching the event type')
						return
					}
					const eventPayload = pbobj.decode(evt.payload)
					if (evt.type === messengerpb.StreamEvent.Type.TypeNotified) {
						const enumName = Object.keys(messengerpb.StreamEvent.Notified.Type).find(
							(name) => messengerpb.StreamEvent.Notified.Type[name] === eventPayload.type,
						)
						const payloadName = enumName.substr('Type'.length)
						const pbobj = messengerpb.StreamEvent.Notified[payloadName]
						if (!pbobj) {
							console.warn('failed to find a protobuf object matching the notification type')
							return
						}
						eventPayload.payload = pbobj.decode(eventPayload.payload)
						eventEmitter.emit('notification', {
							type: eventPayload.type,
							name: payloadName,
							payload: eventPayload,
						})
					} else {
						dispatch({
							type: evt.type,
							name: payloadName,
							payload: eventPayload,
						})
					}
				})
				cancel = await stream.start()
			})
			.catch((err) => {
				if (err === EOF) {
					console.info('end of the events stream')
				} else {
					console.warn('events stream error:', err)
				}
				dispatch({ type: 'SET_STREAM_ERROR', payload: { error: err } })
			})
		return () => cancel()
	}, [embedded, nodeStarted, state.daemonAddress, eventEmitter])

	React.useEffect(() => {
		if (!state.convsClosed && state.listDone) {
			dispatch({ type: 'CONVS_CLOSED' })
			for (const conv of Object.values(state.conversations) as any) {
				if (conv.isOpen) {
					state.client.conversationClose({ groupPk: conv.publicKey }).catch((e: any) => {
						console.warn(`failed to close conversation "${conv.displayName}",`, e)
					})
				}
			}
		}
	}, [state.client, state.conversations, state.convsClosed, state.listDone])

	return (
		<MsgrContext.Provider
			value={{
				...state,
				restart,
				deleteAccount,
				dispatch,
				addNotificationListener,
				removeNotificationListener,
			}}
		>
			{children}
		</MsgrContext.Provider>
	)
}

export default MsgrProvider
