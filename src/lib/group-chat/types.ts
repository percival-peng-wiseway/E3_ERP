export type GroupChatMessage = {
  id: string;
  displayName: string;
  content: string;
  createdAt: string;
};

export type GroupChatListResponse = {
  data: GroupChatMessage[];
};

export type GroupChatMutationResponse = {
  data: GroupChatMessage;
};

export type GroupChatCreateRequest = {
  displayName: string;
  content: string;
};
