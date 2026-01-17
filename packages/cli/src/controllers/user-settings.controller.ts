import { Get, Patch, RestController } from '@n8n/decorators';
import type { NpsSurveyState } from 'n8n-workflow';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { McpUserConfigRequest, NpsSurveyRequest } from '@/requests';
import { UserService } from '@/services/user.service';

function getNpsSurveyState(state: unknown): NpsSurveyState | undefined {
	if (typeof state !== 'object' || state === null) {
		return;
	}
	if (!('lastShownAt' in state) || typeof state.lastShownAt !== 'number') {
		return;
	}
	if ('responded' in state && state.responded === true) {
		return {
			responded: true,
			lastShownAt: state.lastShownAt,
		};
	}

	if (
		'waitingForResponse' in state &&
		state.waitingForResponse === true &&
		'ignoredCount' in state &&
		typeof state.ignoredCount === 'number'
	) {
		return {
			waitingForResponse: true,
			ignoredCount: state.ignoredCount,
			lastShownAt: state.lastShownAt,
		};
	}

	return;
}

function hasJsonConfig(value: unknown): value is { jsonConfig: unknown } {
	return typeof value === 'object' && value !== null && 'jsonConfig' in value;
}

function getMcpUserConfig(payload: unknown): { jsonConfig: string | null } | undefined {
	if (!hasJsonConfig(payload)) {
		return;
	}

	const { jsonConfig } = payload;

	if (jsonConfig === null) {
		return { jsonConfig: null };
	}

	if (typeof jsonConfig !== 'string') {
		return;
	}

	const trimmedConfig = jsonConfig.trim();

	if (trimmedConfig.length === 0) {
		return { jsonConfig: null };
	}

	try {
		const parsed: unknown = JSON.parse(trimmedConfig);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return;
		}
	} catch {
		return;
	}

	return { jsonConfig: trimmedConfig };
}

@RestController('/user-settings')
export class UserSettingsController {
	constructor(private readonly userService: UserService) {}

	@Patch('/nps-survey')
	async updateNpsSurvey(req: NpsSurveyRequest.NpsSurveyUpdate): Promise<void> {
		const state = getNpsSurveyState(req.body);
		if (!state) {
			throw new BadRequestError('Invalid nps survey state structure');
		}

		await this.userService.updateSettings(req.user.id, {
			npsSurvey: state,
		});
	}

	@Get('/mcp-config')
	getMcpConfig(req: McpUserConfigRequest.Get): { jsonConfig: string | null } {
		return {
			jsonConfig: req.user.settings?.mcpConfig?.jsonConfig ?? null,
		};
	}

	@Patch('/mcp-config')
	async updateMcpConfig(req: McpUserConfigRequest.Update): Promise<{ jsonConfig: string | null }> {
		const config = getMcpUserConfig(req.body);
		if (!config) {
			throw new BadRequestError('Invalid MCP configuration structure');
		}

		await this.userService.updateSettings(req.user.id, {
			mcpConfig: config.jsonConfig ? { jsonConfig: config.jsonConfig } : null,
		});

		return config;
	}
}
