<script setup lang="ts">
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { useToast } from '@/app/composables/useToast';
import type { WorkflowListItem } from '@/Interface';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { useMCPStore } from '@/features/ai/mcpAccess/mcp.store';
import { useUsersStore } from '@/features/settings/users/users.store';
import { useUIStore } from '@/app/stores/ui.store';
import {
	LOADING_INDICATOR_TIMEOUT,
	MCP_CONNECT_WORKFLOWS_MODAL_KEY,
	MCP_DOCS_PAGE_URL,
} from '@/features/ai/mcpAccess/mcp.constants';
import MCPEmptyState from '@/features/ai/mcpAccess/components/MCPEmptyState.vue';
import MCpHeaderActions from '@/features/ai/mcpAccess/components/header/MCPHeaderActions.vue';
import WorkflowsTable from '@/features/ai/mcpAccess/components/tabs/WorkflowsTable.vue';
import OAuthClientsTable from '@/features/ai/mcpAccess/components/tabs/OAuthClientsTable.vue';
import {
	N8nHeading,
	N8nTabs,
	N8nTooltip,
	N8nButton,
	N8nText,
	N8nLink,
	N8nInput,
} from '@n8n/design-system';
import type { TabOptions } from '@n8n/design-system';
import { useMcp } from '@/features/ai/mcpAccess/composables/useMcp';
import type { OAuthClientResponseDto } from '@n8n/api-types';
import { useTelemetry } from '@/app/composables/useTelemetry';
import { WORKFLOW_DESCRIPTION_MODAL_KEY } from '@/app/constants';

type MCPTabs = 'workflows' | 'personal' | 'oauth';

const i18n = useI18n();
const toast = useToast();
const documentTitle = useDocumentTitle();
const mcp = useMcp();
const telemetry = useTelemetry();

const mcpStore = useMCPStore();
const usersStore = useUsersStore();
const uiStore = useUIStore();

const mcpStatusLoading = ref(false);
const selectedTab = ref<MCPTabs>('workflows');

const isOwner = computed(() => usersStore.isInstanceOwner);
const isAdmin = computed(() => usersStore.isAdmin);

const canToggleMCP = computed(() => isOwner.value || isAdmin.value);
const canManageOAuth = computed(() => isOwner.value || isAdmin.value);

const tabs = computed<Array<TabOptions<MCPTabs>>>(() => {
	const baseTabs: Array<TabOptions<MCPTabs>> = [
		{
			label: i18n.baseText('settings.mcp.tabs.workflows'),
			value: 'workflows',
		},
		{
			label: i18n.baseText('settings.mcp.tabs.personal'),
			value: 'personal',
		},
	];

	if (canManageOAuth.value) {
		baseTabs.push({
			label: i18n.baseText('settings.mcp.tabs.oauth'),
			value: 'oauth',
		});
	}

	return baseTabs;
});

const workflowsLoading = ref(false);
const availableWorkflows = ref<WorkflowListItem[]>([]);

const oAuthClientsLoading = ref(false);
const connectedOAuthClients = ref<OAuthClientResponseDto[]>([]);

const personalConfig = ref('');
const personalConfigLoading = ref(false);
const personalConfigSaving = ref(false);
const savedPersonalConfig = ref<string | null>(null);

const showConnectWorkflowsButton = computed(() => {
	return (
		selectedTab.value === 'workflows' &&
		mcpStore.mcpAccessEnabled &&
		availableWorkflows.value.length > 0
	);
});

const normalizedPersonalConfig = computed(() => personalConfig.value.trim());

const personalConfigError = computed(() => {
	if (!normalizedPersonalConfig.value) {
		return '';
	}

	try {
		const parsed: unknown = JSON.parse(normalizedPersonalConfig.value);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return i18n.baseText('settings.mcp.personal.config.error.invalidJson');
		}
	} catch {
		return i18n.baseText('settings.mcp.personal.config.error.invalidJson');
	}

	return '';
});

const canSavePersonalConfig = computed(() => {
	const currentValue = normalizedPersonalConfig.value;
	const savedValue = (savedPersonalConfig.value ?? '').trim();
	return !personalConfigSaving.value && !personalConfigError.value && currentValue !== savedValue;
});

const handleTabChange = async (tab: MCPTabs) => {
	if (tab === 'workflows' && mcpStore.mcpAccessEnabled && availableWorkflows.value.length === 0) {
		await fetchAvailableWorkflows();
	} else if (tab === 'personal' && savedPersonalConfig.value === null) {
		await fetchPersonalConfig();
	} else if (tab === 'oauth' && canManageOAuth.value && connectedOAuthClients.value.length === 0) {
		await fetchoAuthCLients();
		telemetry.track('User clicked connected clients tab');
	}
};

watch(
	selectedTab,
	async (tab) => {
		await handleTabChange(tab);
	},
	{ immediate: true },
);

const onToggleMCPAccess = async (enabled: boolean) => {
	try {
		mcpStatusLoading.value = true;
		const updated = await mcpStore.setMcpAccessEnabled(enabled);
		if (updated) {
			await fetchAvailableWorkflows();
			await fetchoAuthCLients();
		} else {
			workflowsLoading.value = false;
		}
		mcp.trackUserToggledMcpAccess(enabled);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.mcp.toggle.error'));
	} finally {
		mcpStatusLoading.value = false;
		workflowsLoading.value = false;
	}
};

const onToggleWorkflowMCPAccess = async (workflowId: string, isEnabled: boolean) => {
	try {
		await mcpStore.toggleWorkflowMcpAccess(workflowId, isEnabled);
		if (isEnabled) {
			await fetchAvailableWorkflows();
		} else {
			availableWorkflows.value = availableWorkflows.value.filter((w) => w.id !== workflowId);
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('workflowSettings.toggleMCP.error.title'));
		throw error;
	}
};

const onUpdateDescription = (workflow: WorkflowListItem) => {
	uiStore.openModalWithData({
		name: WORKFLOW_DESCRIPTION_MODAL_KEY,
		data: {
			workflowId: workflow.id,
			workflowDescription: workflow.description ?? '',
			onSave: (updatedDescription: string | null) => {
				const index = availableWorkflows.value.findIndex((w) => w.id === workflow.id);
				if (index !== -1) {
					availableWorkflows.value[index] = {
						...availableWorkflows.value[index],
						description: updatedDescription ?? undefined,
					};
				}
			},
		},
	});
};

const onTableRefresh = async () => {
	if (selectedTab.value === 'workflows' && mcpStore.mcpAccessEnabled) {
		await fetchAvailableWorkflows();
	} else if (selectedTab.value === 'personal') {
		await fetchPersonalConfig();
	} else if (selectedTab.value === 'oauth') {
		await fetchoAuthCLients();
	}
};

const fetchAvailableWorkflows = async () => {
	if (!mcpStore.mcpAccessEnabled) {
		return;
	}

	workflowsLoading.value = true;
	try {
		const workflows = await mcpStore.fetchWorkflowsAvailableForMCP(1, 200);
		availableWorkflows.value = workflows;
	} catch (error) {
		toast.showError(error, i18n.baseText('workflows.list.error.fetching'));
	} finally {
		setTimeout(() => {
			workflowsLoading.value = false;
		}, LOADING_INDICATOR_TIMEOUT);
	}
};

const onRefreshWorkflows = async () => {
	await fetchAvailableWorkflows();
};

const fetchoAuthCLients = async () => {
	if (!canManageOAuth.value) {
		return;
	}
	try {
		oAuthClientsLoading.value = true;
		const clients = await mcpStore.getAllOAuthClients();
		connectedOAuthClients.value = clients;
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.mcp.error.fetching.oAuthClients'));
	} finally {
		setTimeout(() => {
			oAuthClientsLoading.value = false;
		}, LOADING_INDICATOR_TIMEOUT);
	}
};

const fetchPersonalConfig = async () => {
	try {
		personalConfigLoading.value = true;
		const config = await mcpStore.getUserMcpConfig();
		savedPersonalConfig.value = config;
		personalConfig.value = config ?? '';
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.mcp.personal.config.error.fetch'));
	} finally {
		setTimeout(() => {
			personalConfigLoading.value = false;
		}, LOADING_INDICATOR_TIMEOUT);
	}
};

const savePersonalConfig = async () => {
	if (!canSavePersonalConfig.value) {
		return;
	}

	try {
		personalConfigSaving.value = true;
		const updated = await mcpStore.setUserMcpConfig(
			normalizedPersonalConfig.value ? normalizedPersonalConfig.value : null,
		);
		savedPersonalConfig.value = updated;
		personalConfig.value = updated ?? '';
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('settings.mcp.personal.config.success.title'),
			message: i18n.baseText('settings.mcp.personal.config.success.message'),
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.mcp.personal.config.error.save'));
	} finally {
		setTimeout(() => {
			personalConfigSaving.value = false;
		}, LOADING_INDICATOR_TIMEOUT);
	}
};

const revokeClientAccess = async (client: OAuthClientResponseDto) => {
	try {
		await mcpStore.removeOAuthClient(client.id);
		connectedOAuthClients.value = connectedOAuthClients.value.filter((c) => c.id !== client.id);
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('settings.mcp.oAuthClients.revoke.success.title'),
			message: i18n.baseText('settings.mcp.oAuthClients.revoke.success.message', {
				interpolate: { name: client.name },
			}),
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.mcp.oAuthClients.revoke.error'));
	}
};

const openConnectWorkflowsModal = () => {
	uiStore.openModalWithData({
		name: MCP_CONNECT_WORKFLOWS_MODAL_KEY,
		data: {
			onEnableMcpAccess: async (workflowId: string) => {
				await onToggleWorkflowMCPAccess(workflowId, true);
			},
		},
	});
	telemetry.track('User clicked connect workflows from mcp settings');
};

onMounted(() => {
	documentTitle.set(i18n.baseText('settings.mcp'));
});
</script>
<template>
	<div :class="$style.container">
		<header :class="$style['main-header']" data-test-id="mcp-settings-header">
			<div :class="$style.headings">
				<N8nHeading size="2xlarge" class="mb-2xs">{{ i18n.baseText('settings.mcp') }}</N8nHeading>
				<div v-show="mcpStore.mcpAccessEnabled" data-test-id="mcp-settings-description">
					<N8nText size="small" color="text-light">
						{{ i18n.baseText('settings.mcp.description') }}.
					</N8nText>
					<N8nLink
						:href="MCP_DOCS_PAGE_URL"
						target="_blank"
						rel="noopener noreferrer"
						size="small"
						data-test-id="mcp-docs-link"
					>
						{{ i18n.baseText('generic.learnMore') }}
					</N8nLink>
				</div>
			</div>
			<MCpHeaderActions
				:access-enabled="mcpStore.mcpAccessEnabled"
				:toggle-disabled="!canToggleMCP"
				:loading="mcpStatusLoading"
				@disable-mcp-access="onToggleMCPAccess(!mcpStore.mcpAccessEnabled)"
			/>
		</header>
		<div :class="$style.container" data-test-id="mcp-enabled-section">
			<header :class="$style['tabs-header']">
				<N8nTabs v-model="selectedTab" :options="tabs" />
				<div :class="$style.actions">
					<N8nButton
						v-if="showConnectWorkflowsButton"
						:label="i18n.baseText('settings.mcp.connectWorkflows')"
						data-test-id="mcp-connect-workflows-header-button"
						size="small"
						type="primary"
						@click="openConnectWorkflowsModal"
					/>
					<N8nTooltip :content="i18n.baseText('settings.mcp.refresh.tooltip')">
						<N8nButton
							data-test-id="mcp-workflows-refresh-button"
							size="small"
							type="tertiary"
							icon="refresh-cw"
							:square="true"
							:disabled="selectedTab === 'workflows' && !mcpStore.mcpAccessEnabled"
							@click="onTableRefresh"
						/>
					</N8nTooltip>
				</div>
			</header>
			<main>
				<WorkflowsTable
					v-if="selectedTab === 'workflows' && mcpStore.mcpAccessEnabled"
					:data-test-id="'mcp-workflow-table'"
					:workflows="availableWorkflows"
					:loading="workflowsLoading"
					@remove-mcp-access="(workflow) => onToggleWorkflowMCPAccess(workflow.id, false)"
					@connect-workflows="openConnectWorkflowsModal"
					@update-description="onUpdateDescription"
					@refresh="onRefreshWorkflows"
				/>
				<MCPEmptyState
					v-else-if="selectedTab === 'workflows'"
					:disabled="!canToggleMCP"
					:loading="mcpStatusLoading"
					@turn-on-mcp="onToggleMCPAccess(true)"
				/>
				<section
					v-else-if="selectedTab === 'personal'"
					:class="$style['personal-config']"
					data-test-id="mcp-personal-config"
				>
					<N8nText size="small" color="text-light">
						{{ i18n.baseText('settings.mcp.personal.description') }}
					</N8nText>
					<div :class="$style['personal-config-input']">
						<label :class="$style.label" for="mcp-personal-config-input">
							{{ i18n.baseText('settings.mcp.personal.config.label') }}
						</label>
						<N8nInput
							id="mcp-personal-config-input"
							v-model="personalConfig"
							type="textarea"
							:rows="10"
							:disabled="personalConfigLoading || personalConfigSaving"
							:placeholder="i18n.baseText('settings.mcp.personal.config.placeholder')"
							data-test-id="mcp-personal-config-input"
						/>
						<N8nText
							v-if="personalConfigError"
							size="small"
							color="text-danger"
							data-test-id="mcp-personal-config-error"
						>
							{{ personalConfigError }}
						</N8nText>
						<N8nText size="small" color="text-light">
							{{ i18n.baseText('settings.mcp.personal.config.helper') }}
						</N8nText>
					</div>
					<div :class="$style['personal-config-actions']">
						<N8nButton
							:label="i18n.baseText('settings.mcp.personal.config.save')"
							size="small"
							type="primary"
							:loading="personalConfigSaving"
							:disabled="!canSavePersonalConfig"
							data-test-id="mcp-personal-config-save"
							@click="savePersonalConfig"
						/>
					</div>
				</section>
				<OAuthClientsTable
					v-else-if="selectedTab === 'oauth' && canManageOAuth"
					:data-test-id="'mcp-oauth-clients-table'"
					:clients="connectedOAuthClients"
					:loading="oAuthClientsLoading"
					@revoke-client="revokeClientAccess"
					@refresh="onTableRefresh"
				/>
			</main>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
}

.main-header {
	display: flex;
	justify-content: space-between;
	margin-bottom: var(--spacing--xl);

	@media (max-width: 820px) {
		flex-direction: column;
		align-items: flex-start;
		gap: var(--spacing--2xs);
	}
}

.headings {
	display: flex;
	flex-direction: column;
	min-height: 60px;
}

.tabs-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
}

.actions {
	display: flex;
	gap: var(--spacing--2xs);
}

.personal-config {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.personal-config-input {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.personal-config-actions {
	display: flex;
	justify-content: flex-end;
}

.label {
	font-size: var(--font-size--sm);
	color: var(--color--text--shade-1);
}
</style>
