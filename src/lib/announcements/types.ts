export type Announcement = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  createdBy: string;
};

export type AnnouncementCreateInput = Pick<Announcement, "title" | "content">;

export type AnnouncementPatchInput = Partial<AnnouncementCreateInput>;

export type AnnouncementListResponse = {
  data: Announcement[];
};

export type AnnouncementMutationResponse = {
  data: Announcement;
};

